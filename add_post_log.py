
import json
import datetime

log_file = 'state/posts_log.json'
with open(log_file, 'r') as f:
    data = json.load(f)

current_time = datetime.datetime.now(datetime.timezone.utc).isoformat()

new_post = {
    "id": "",
    "date": datetime.date.today().isoformat(),
    "cycle": data["total_posts"] + 1,
    "type": "quote",
    "content": "This tweet forces a critical look at the consistency of human rights advocacy, questioning selective outrage and the motivations behind protests for specific causes.",
    "tweet_url": "",
    "journal_url": "",
    "source_url": "https://x.com/realMaalouf/status/2028334672732618965",
    "posted_at": current_time
}

data["posts"].append(new_post)
data["total_posts"] += 1

with open(log_file, 'w') as f:
    json.dump(data, f, indent=2)
