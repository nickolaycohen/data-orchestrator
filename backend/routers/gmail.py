from fastapi import APIRouter
from backend.config import REPOS

router = APIRouter(prefix="/api/gmail", tags=["gmail"])

@router.get("/metrics")
def get_gmail_metrics():
    repo_path = REPOS["gmail-cleanup-planner"]
    token_file = repo_path / "token.json"
    creds_file = repo_path / "credentials.json"
    
    token_exists = token_file.exists() and token_file.stat().st_size > 20
    creds_exists = creds_file.exists() and creds_file.stat().st_size > 20

    rule_families = [
        {"name": "Newsletters", "domains": ["nytimes.com", "substack.com", "medium.com"], "color": "#8b5cf6"},
        {"name": "Cloud Notifications", "domains": ["dropbox.com", "drive.google.com", "box.com"], "color": "#0ea5e9"},
        {"name": "Social Media", "domains": ["facebook.com", "twitter.com", "linkedin.com"], "color": "#f59e0b"},
        {"name": "E-Commerce & Orders", "domains": ["amazon.com", "ebay.com", "shopify.com"], "color": "#10b981"},
        {"name": "Marketing & Promotions", "domains": ["promotions", "marketing", "updates"], "color": "#ec4899"}
    ]

    existing_rules = [
        {"name": "Dropbox Large Attachments", "query": "from:dropbox.com larger:10M", "family": "Cloud Notifications", "action": "Archive / Delete Candidates"},
        {"name": "Old Newsletters (>1 yr)", "query": "from:nytimes.com older_than:1y", "family": "Newsletters", "action": "Purge"},
        {"name": "Substack Daily Digest", "query": "from:substack.com older_than:6m", "family": "Newsletters", "action": "Archive"},
        {"name": "Social Alert Debris", "query": "from:(facebook.com OR twitter.com)", "family": "Social Media", "action": "Batch Clean"}
    ]

    return {
        "connected": repo_path.exists(),
        "has_credentials": creds_exists,
        "has_token": token_exists,
        "auth_status": "Authenticated" if token_exists else ("Credentials Configured" if creds_exists else "Setup Needed"),
        "rule_families": rule_families,
        "existing_rules": existing_rules,
        "thresholds": {
            "suggest_count_threshold": 50,
            "suggest_size_threshold_mb": 50,
            "batch_size": 100
        }
    }
