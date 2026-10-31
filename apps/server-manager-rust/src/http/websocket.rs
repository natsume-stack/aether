//! Authenticated subscriptions only; commands retain their HTTP mutation contract.
use crate::*;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use std::{collections::BTreeSet, sync::{Mutex, OnceLock}, time::Instant};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Subscription {
    topics: Vec<String>,
    operations: Vec<String>,
}

fn valid_subscription(value: &Subscription) -> bool {
    value.topics.len() <= 3 && value.operations.len() <= 32 &&
    value.topics.iter().all(|t| matches!(t.as_str(), "overview" | "runtimes" | "performance")) &&
    value.operations.iter().all(|id| (16..=80).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b)))
}

pub(crate) async fn upgrade(State(app): State<Arc<App>>, headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    // Check the browser origin before upgrading; the token arrives in the first frame.
    let mut origin_check = headers.clone();
    origin_check.insert(header::AUTHORIZATION, format!("Bearer {}", app.token).parse().unwrap());
    if let Err(response) = auth(&origin_check, &app) { return response; }
    static CONNECTIONS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let permits = CONNECTIONS.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(128))).clone();
    let Ok(permit) = permits.try_acquire_owned() else { return StatusCode::SERVICE_UNAVAILABLE.into_response(); };
    ws.max_message_size(8192).max_frame_size(8192).on_upgrade(move |socket| async move {
        let _permit = permit;
        serve(socket, app, headers).await;
    })
}

fn sample(app: &App, topic: &str) -> Result<Value, String> {
    // Cache one sample per service/topic rather than collecting Docker stats per viewer.
    type Cache = BTreeMap<(PathBuf, String), (Instant, Value)>;
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(|| Mutex::new(BTreeMap::new())).lock().map_err(|_| "状态采集不可用")?;
    let key = (app.root.clone(), topic.into());
    if let Some((time, value)) = cache.get(&key) {
        if time.elapsed() < Duration::from_secs(4) { return Ok(value.clone()); }
    }
    let value = match topic {
        "overview" => system_status(app)?,
        "runtimes" => runtime_catalog(app),
        "performance" => performance(app)?,
        _ => return Err("未知订阅".into()),
    };
    if cache.len() > 16 { cache.clear(); }
    cache.insert(key, (Instant::now(), value.clone()));
    Ok(value)
}
async fn send(socket: &mut WebSocket, value: Value) -> bool {
    matches!(tokio::time::timeout(Duration::from_secs(5), socket.send(Message::Text(value.to_string().into()))).await, Ok(Ok(())))
}
async fn serve(mut socket: WebSocket, app: Arc<App>, mut headers: HeaderMap) {
    let first = tokio::time::timeout(Duration::from_secs(5), socket.recv()).await;
    let Ok(Some(Ok(Message::Text(text)))) = first else { return; };
    let Ok(value) = serde_json::from_str::<Value>(&text) else { return; };
    let Some(token) = value.get("token").and_then(Value::as_str) else { return; };
    let Ok(bearer) = format!("Bearer {token}").parse() else { return; };
    headers.insert(header::AUTHORIZATION, bearer);
    if value.get("type").and_then(Value::as_str) != Some("authenticate") || auth(&headers, &app).is_err() {
        let _ = socket.send(Message::Close(Some(axum::extract::ws::CloseFrame { code: 1008, reason: "管理令牌无效".into() }))).await;
        return;
    }
    let mut updates = app.operations.subscribe();
    let mut topics = BTreeSet::new();
    let mut operations = BTreeSet::new();
    let mut previous = BTreeMap::<String, Value>::new();
    let mut timer = tokio::time::interval(Duration::from_secs(5));
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_seen = Instant::now();
    if !send(&mut socket, json!({"type":"ready"})).await { return; }
    loop {
        tokio::select! {
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        let Ok(subscription) = serde_json::from_str::<Subscription>(&text) else { break; };
                        if !valid_subscription(&subscription) { break; }
                        topics = subscription.topics.into_iter().collect();
                        operations = subscription.operations.into_iter().collect();
                        previous.clear();
                        last_seen = Instant::now();
                        for id in &operations {
                            if let Some(progress) = app.operations.get(id) {
                                if !send(&mut socket, json!({"type":"progress","id":id,"payload":progress})).await { return; }
                            }
                        }
                        timer.reset_immediately();
                    }
                    Some(Ok(Message::Pong(_))) | Some(Ok(Message::Ping(_))) => last_seen = Instant::now(),
                    _ => break,
                }
            }
            update = updates.recv() => {
                match update {
                    Ok((id, progress)) if operations.contains(&id) => {
                        if !send(&mut socket, json!({"type":"progress","id":id,"payload":progress})).await { break; }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        for id in &operations {
                            if let Some(progress) = app.operations.get(id) {
                                if !send(&mut socket, json!({"type":"progress","id":id,"payload":progress})).await { return; }
                            }
                        }
                    }
                    _ => {}
                }
            }
            _ = timer.tick() => {
                if last_seen.elapsed() > Duration::from_secs(65) { break; }
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
                for topic in &topics {
                    let sample_app = app.clone(); let name = topic.clone();
                    let result = tokio::task::spawn_blocking(move || sample(&sample_app, &name)).await;
                    let value = match result { Ok(Ok(value)) => value, _ => {
                        if !send(&mut socket, json!({"type":"error","topic":topic,"message":"运行状态采集失败"})).await { return; }
                        continue;
                    }};
                    if previous.get(topic) != Some(&value) {
                        if !send(&mut socket, json!({"type":"snapshot","topic":topic,"payload":value})).await { return; }
                        previous.insert(topic.clone(), value);
                    }
                }
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn subscription_allowlist_and_capacity() {
        assert!(valid_subscription(&Subscription { topics: vec!["overview".into()], operations: vec!["operation-00000001".into()] }));
        assert!(!valid_subscription(&Subscription { topics: vec!["save_raw_environment".into()], operations: vec![] }));
        assert!(!valid_subscription(&Subscription { topics: vec![], operations: vec!["../invalid".into()] }));
        assert!(!valid_subscription(&Subscription { topics: vec![], operations: vec!["operation-00000001".into(); 33] }));
    }
    #[tokio::test]
    async fn actual_websocket_auth_origin_and_progress_replay() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::{connect_async, tungstenite::{client::IntoClientRequest, Message as Frame}};
        let app = Arc::new(App {
            root: PathBuf::from("/unused-ws-test-root"), token: "fixture-token-with-at-least-32-chars".into(),
            runtime_token: "fixture-runtime-with-at-least-32-chars".into(),
            compose_file: PathBuf::from("/unused-ws-test-root/compose.yml"),
            environment_file: PathBuf::from("/unused-ws-test-root/.env"),
            operations: Arc::new(Operations::default()), operation_id: None,
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let router = Router::new().route("/api/events", get(upgrade)).with_state(app.clone());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap(); });
        let url = format!("ws://{addr}/api/events");
        let mut bad_origin = url.clone().into_client_request().unwrap();
        bad_origin.headers_mut().insert("origin", "http://other-host".parse().unwrap());
        assert!(connect_async(bad_origin).await.is_err());
        let (mut bad_token, _) = connect_async(&url).await.unwrap();
        bad_token.send(Frame::Text(json!({"type":"authenticate","token":"wrong"}).to_string().into())).await.unwrap();
        let closed = bad_token.next().await.unwrap().unwrap();
        assert!(matches!(closed, Frame::Close(Some(frame)) if u16::from(frame.code) == 1008));
        let (mut ws, _) = connect_async(&url).await.unwrap();
        ws.send(Frame::Text(json!({"type":"authenticate","token":app.token}).to_string().into())).await.unwrap();
        assert_eq!(ws.next().await.unwrap().unwrap().into_text().unwrap(), "{\"type\":\"ready\"}");
        let id = "operation-ws-fixture-01";
        app.operations.begin(id).unwrap();
        app.operations.update(id, "pull", "fixture", 42, false);
        ws.send(Frame::Text(json!({"topics":[],"operations":[id]}).to_string().into())).await.unwrap();
        async fn progress<S>(ws: &mut S) -> Value where S: futures_util::Stream<Item=Result<Frame, tokio_tungstenite::tungstenite::Error>> + Unpin {
            loop { if let Frame::Text(value) = tokio::time::timeout(Duration::from_secs(2), ws.next()).await.unwrap().unwrap().unwrap() { return serde_json::from_str(&value).unwrap(); } }
        }
        let replay = progress(&mut ws).await;
        assert_eq!(replay["id"], id); assert_eq!(replay["payload"]["percent"], 42);
        app.operations.update_download(id, "play", 25, 100);
        let download = progress(&mut ws).await;
        assert_eq!(download["payload"]["stage"], "image-download");
        assert_eq!(download["payload"]["downloads"][0]["percent"], 25);
        assert_eq!(download["payload"]["downloads"][0]["image"], "box-local-engine-play");
        app.operations.update(id, "done", "fixture", 100, true);
        assert_eq!(progress(&mut ws).await["payload"]["percent"], 100);
        ws.close(None).await.unwrap(); server.abort();
    }

}
