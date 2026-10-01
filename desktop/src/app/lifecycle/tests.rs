use super::dashboard_url;

#[test]
fn dashboard_links_append_encoded_segments_to_either_base_form() {
    for base in ["http://127.0.0.1:9317/dashboard", "http://127.0.0.1:9317/dashboard/"] {
        assert_eq!(
            dashboard_url(base, &["providers", ""]).as_deref(),
            Some("http://127.0.0.1:9317/dashboard/providers/")
        );
        assert_eq!(
            dashboard_url(base, &["providers", "team a/b", "edit"]).as_deref(),
            Some("http://127.0.0.1:9317/dashboard/providers/team%20a%2Fb/edit")
        );
    }
    assert_eq!(dashboard_url("not a url", &["providers", ""]), None);
}
