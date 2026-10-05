use std::path::Path;

use gpui_kit::AssetSource;
use gpui_kit::assets::IconName;

use super::AppAssets;

/// Every icon variant the sources name, so a new icon cannot ship unregistered.
fn icons_named_in(dir: &Path, names: &mut Vec<String>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            icons_named_in(&path, names);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            let source = std::fs::read_to_string(&path).unwrap();
            for prefix in ["Lucide::", "IconName::"] {
                for (at, _) in source.match_indices(prefix) {
                    let rest = &source[at + prefix.len()..];
                    let name: String = rest.chars().take_while(char::is_ascii_alphanumeric).collect();
                    if name.starts_with(|c: char| c.is_ascii_uppercase()) && name != "ALL" {
                        names.push(name);
                    }
                }
            }
        }
    }
}

#[test]
fn every_icon_the_app_draws_is_embedded() {
    let mut names = Vec::new();
    icons_named_in(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut names);
    assert!(names.iter().any(|name| name == "PowerOff"), "the scan found no icons: {names:?}");
    for name in names {
        let icon = IconName::ALL
            .iter()
            .find(|icon| format!("{icon:?}") == name)
            .unwrap_or_else(|| panic!("{name} is not a GPUI Kit icon"));
        assert!(AppAssets.load(&icon.path()).ok().flatten().is_some(), "{name} is not embedded; add it to ExtraIcons");
    }
}
