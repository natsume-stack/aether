use std::collections::BTreeMap;

fn assignment(line: &str) -> Option<(&str, &str)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let (key, value) = line.split_once('=')?;
    Some((key.trim(), value.trim()))
}

pub fn parse_env(content: &str) -> BTreeMap<String, String> {
    content
        .lines()
        .filter_map(assignment)
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

pub fn set_env(content: &mut String, key: &str, value: &str) -> Result<(), String> {
    if value.contains(['\r', '\n']) {
        return Err(format!("配置项 {key} 不能包含换行符"));
    }
    let replacement = format!("{key}={value}");
    let mut found = false;
    let mut lines = Vec::new();
    for line in content.lines() {
        if assignment(line).is_some_and(|(name, _)| name == key) {
            if !found {
                lines.push(replacement.clone());
            }
            found = true;
        } else {
            lines.push(line.to_string());
        }
    }
    if !found {
        lines.push(replacement);
    }
    *content = format!("{}\n", lines.join("\n"));
    Ok(())
}

pub fn remove_env(content: &mut String, key: &str) {
    *content = format!(
        "{}\n",
        content
            .lines()
            .filter(|line| !assignment(line).is_some_and(|(name, _)| name == key))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updates_spaced_and_duplicate_keys_without_touching_comments() {
        let mut source = "# PORT=example\n PORT = 1\nPORT=2\nOTHER_PORT=3\n".to_string();
        set_env(&mut source, "PORT", "4").unwrap();
        assert_eq!(source, "# PORT=example\nPORT=4\nOTHER_PORT=3\n");
        remove_env(&mut source, "PORT");
        assert_eq!(source, "# PORT=example\nOTHER_PORT=3\n");
    }

    #[test]
    fn invalid_updates_leave_source_unchanged() {
        let mut source = "PORT=1\n".to_string();
        assert!(set_env(&mut source, "PORT", "2\nOTHER=3").is_err());
        assert_eq!(source, "PORT=1\n");
    }

    #[test]
    fn parses_comments_and_values_containing_equals() {
        let values = parse_env("# EXAMPLE=value\n KEY = a=b\nKEY=last=value\n");
        assert_eq!(values.len(), 1);
        assert_eq!(values["KEY"], "last=value");
    }
}
