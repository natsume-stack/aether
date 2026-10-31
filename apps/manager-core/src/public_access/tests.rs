use super::*;
#[test]
fn shared_ports_and_custom_paths_keep_independent_drafts() {
    let config = json!({"publicAddressMode":"shared","playNetworkMode":"public","sharedPublicAddress":"https://abc.example.test","playPublicAddressOverride":"https://old.example.test","publicServicePaths":{"creator":"/arena"}});
    let result = prepare(config.as_object().unwrap()).unwrap();
    assert_eq!(
        result["playPublicAddressOverride"],
        "https://abc.example.test:3121"
    );
    assert_eq!(
        result["creatorPublicAddressOverride"],
        "https://abc.example.test/arena"
    );
    let doc = save_document("", config.as_object().unwrap()).unwrap();
    let values = environment::parse_env(&doc);
    assert_eq!(
        view(&values)["playPublicAddressOverride"],
        "https://old.example.test"
    );
    assert!(!values.contains_key("BOX_PLAY_PUBLIC_HOST"));
    assert!(prefix("/../api").is_err());
    assert!(prefix("/api").is_err());
}
#[test]
fn independent_addresses_do_not_use_shared_path_drafts() {
    let config = json!({"publicAddressMode":"independent","playPublicAddressOverride":"https://play.example.test","publicServicePaths":{"play":"/play"}});
    let result = prepare(config.as_object().unwrap()).unwrap();
    assert_eq!(
        result["playPublicAddressOverride"],
        "https://play.example.test"
    );
    let doc = save_document("", config.as_object().unwrap()).unwrap();
    let values = environment::parse_env(&doc);
    assert_eq!(
        values["BOX_PLAY_PUBLIC_ADDRESS_OVERRIDE"],
        "https://play.example.test"
    );
    assert_eq!(view(&values)["publicServicePaths"]["play"], "/play");
}
#[test]
fn automatic_schemes_keep_raw_drafts_and_explicit_protocols_and_ports() {
    for (address, secure, expected) in [
        ("play.example.test", false, "http://play.example.test"),
        ("play.example.test", true, "https://play.example.test"),
        (
            "play.example.test:8443",
            true,
            "https://play.example.test:8443",
        ),
        ("http://play.example.test", true, "http://play.example.test"),
        (
            "https://play.example.test",
            false,
            "https://play.example.test",
        ),
        ("203.0.113.10", true, "https://203.0.113.10:3121"),
        ("2001:db8::1", false, "http://[2001:db8::1]:3121"),
        ("[2001:db8::1]:8443", true, "https://[2001:db8::1]:8443"),
    ] {
        let config = json!({"publicAddressMode":"independent","playPublicAddressOverride":address,"publicSslConfigured":{"play":secure}});
        let prepared = prepare(config.as_object().unwrap()).unwrap();
        assert_eq!(prepared["playPublicAddressOverride"], expected);
        assert_eq!(
            prepare(&prepared).unwrap()["playPublicAddressOverride"],
            expected
        );
        let values = environment::parse_env(&save_document("", &prepared).unwrap());
        assert_eq!(values["BOX_PLAY_PUBLIC_ADDRESS_OVERRIDE"], expected);
        assert_eq!(view(&values)["playPublicAddressOverride"], address);
    }
}
#[test]
fn shared_automatic_tls_uses_default_https_for_paths_and_selected_ports_without_paths() {
    let config = json!({"publicAddressMode":"shared","sharedPublicAddress":"abc.example.test","publicSslConfigured":{"shared":true},"publicServicePaths":{"play":"/play"}});
    let prepared = prepare(config.as_object().unwrap()).unwrap();
    assert_eq!(
        prepared["playPublicAddressOverride"],
        "https://abc.example.test/play"
    );
    assert_eq!(
        prepared["creatorPublicAddressOverride"],
        "https://abc.example.test:3127"
    );
    let values = environment::parse_env(&save_document("", &prepared).unwrap());
    assert_eq!(
        values["BOX_PLAY_PUBLIC_ADDRESS_OVERRIDE"],
        "https://abc.example.test/play"
    );
    assert_eq!(view(&values)["sharedPublicAddress"], "abc.example.test");
}

#[cfg(test)]
mod repeated_access_mode_tests {
    use super::*;
    #[test]
    fn saving_switching_and_reloading_ip_domain_and_tls_drafts_does_not_conflict() {
        for (address, secure) in [
            ("203.0.113.10", false),
            ("203.0.113.10", true),
            ("http://203.0.113.10:4121", false),
            ("https://203.0.113.10:8443", true),
            ("play.example.test", false),
            ("play.example.test", true),
            ("http://play.example.test", false),
            ("https://play.example.test", true),
            ("[2001:db8::1]:8443", true),
        ] {
            let mut content = String::new();
            for mode in ["public", "local", "lan", "public", "local", "public"] {
                let config = json!({"publicAddressMode":"independent","playNetworkMode":mode,"creatorNetworkMode":"local","playPublicAddressOverride":address,"authPortalPublicAddressOverride":"https://auth.example.test/accounts","publicSslConfigured":{"play":secure}});
                let prepared = prepare(config.as_object().unwrap()).unwrap();
                content = save_document(&content, config.as_object().unwrap()).unwrap();
                content =
                    crate::access_settings::save(&content, "", mode, "local", Some("192.168.1.9"))
                        .unwrap();
                let values = environment::parse_env(&content);
                let runtime = configuration::runtime_environment(
                    &values,
                    &configuration::RuntimeInputs {
                        lan_ip: Some("192.168.1.9"),
                        image_tag: "test",
                        platform: "linux/amd64",
                        database_required: false,
                        web_manager: true,
                    },
                )
                .unwrap();
                let expected = match mode {
                    "public" => prepared["playPublicAddressOverride"].as_str().unwrap(),
                    "lan" => "http://192.168.1.9:3121",
                    _ => "http://127.0.0.1:3121",
                };
                assert_eq!(
                    runtime["BOX_PLAY_PUBLIC_URL"], expected,
                    "{address}, {mode}"
                );
                assert_eq!(runtime["BOX_CREATOR_PUBLIC_URL"], "http://127.0.0.1:3127");
                assert_eq!(
                    runtime["BOX_PLAYER_LOGIN_URL"],
                    runtime["BOX_AUTH_PORTAL_PUBLIC_URL"]
                );
                assert_eq!(view(&values)["playPublicAddressOverride"], address);
                assert_eq!(
                    runtime["BOX_BIND_IP"],
                    if mode == "local" {
                        "127.0.0.1"
                    } else {
                        "0.0.0.0"
                    }
                );
            }
        }
    }
}

#[cfg(test)]
mod inactive_draft_tests {
    use super::*;
    #[test]
    fn incomplete_drafts_do_not_block_local_or_lan_save() {
        for mode in ["local", "lan"] {
            for address_mode in ["shared", "independent"] {
                let config = json!({"publicAddressMode":address_mode,"playNetworkMode":mode,"creatorNetworkMode":mode,"sharedPublicAddress":"https://","playPublicAddressOverride":"https://","publicServicePaths":{"play":"/../in-progress"}});
                let prepared = prepare(config.as_object().unwrap()).unwrap();
                crate::configuration::validate_configuration(&prepared).unwrap();
                let doc = save_document("", config.as_object().unwrap()).unwrap();
                let values = environment::parse_env(&doc);
                assert_eq!(view(&values)["playPublicAddressOverride"], "https://");
                assert_eq!(view(&values)["sharedPublicAddress"], "https://");
                assert_eq!(prepared["playPublicAddressOverride"], "");
            }
        }
    }
}
