"""The Evaluator's platform policy checks (Video Styles build spec section 7, added 2026-11-10, from the AI video craze
research). Plain rules over the scoring record; each returns findings with a plain reason, and a "reject" stops the
post from moving on (core/bot_content_studio_tools.py and the store's submit step call `check`).

- Sameness: YouTube judges inauthentic content across a channel's recent uploads (reported: the last 30). A draft is
  compared with the channel's last 30 other posts: a near-copy of a script, the same title, or the same opening line
  is rejected; one format filling most of the channel is a warning to vary it.
- AI personas: the narrator or mascot is never presented as a doctor, lawyer, financial adviser or political expert
  (YouTube, 2026-07-16 clarification). First-person or narrator claims of such a role are rejected.
- Off-putting hooks: distress or rescue openings (an animal or a child in distress, then saved) are rejected.
- Cross-posting: the same video never goes out on two of our own channels on one platform, or across niches. Within one
  niche, its YouTube, TikTok and Instagram channels carry the same video by design (locked spec section 4).
- The AI label stays on every post: the store refuses to turn it off (store.py).

Ported formats (section 2, build unit 2). A post made from a format card, and every port proposal, also gets:
- Distance from the source: no name on the card's do-not-use list (the source channels, their mascots, series names and
  lines) in the title, thumbnail, mascot, premise or script, and no title close enough to a source video's title to be
  mistaken for it. Structure and premise type may be reused; names, mascots, artwork and lines may not.
- Audience match (ports): why the audiences match, with linked, dated evidence; stale evidence and a target niche with no
  channel on the source audience's platform are warnings.
- Cost to make (ports): a pack that is not built yet, or a format longer than the pack can make, is refused; a pack
  much dearer than the cheapest one that could make it is a warning (formats.cost; planning units, not measured).
- Series rule: each episode is its own concept. The last few episodes of the same format on the channel are compared,
  and one with the same concept is refused (YouTube: "each video has a distinct storyline, focus, or concept").

Evidence for an appeal (approval, shot plan, sources, these checks) is stored per post in `post_evidence`.
"""
import re

RECENT = 30
SCRIPT_NEAR_COPY = .5      # share of word 3-grams two scripts have in common (Jaccard) at which a draft is a near-copy
MIN_GRAMS = 12             # a script shorter than this (in 3-grams) is too short to call a copy
TITLE_SAME = .8
OPENING_WORDS = 8
FORMAT_MAJORITY = .6       # one format in this share of the last posts (with at least MIN_FOR_FORMAT of them) warns

EXPERT_ROLES = (
    # health
    "doctor", "physician", "surgeon", "nurse", "pharmacist", "dietitian", "nutritionist", "therapist", "psychiatrist",
    "psychologist", "dentist", "pediatrician", "cardiologist", "dermatologist", "medical expert", "health expert",
    "medical professional", "healthcare professional",
    # legal
    "lawyer", "attorney", "solicitor", "barrister", "judge", "paralegal", "legal expert", "legal professional",
    # money
    "financial advisor", "financial adviser", "financial planner", "investment advisor", "investment adviser",
    "wealth manager", "accountant", "cpa", "tax advisor", "tax adviser", "stockbroker", "broker", "banker",
    "money expert", "finance expert", "financial expert", "certified financial planner", "fiduciary",
    # politics
    "politician", "senator", "congressman", "congresswoman", "member of parliament", "political expert",
    "political analyst", "political scientist", "campaign strategist", "election expert")
_ROLE = "(?:" + "|".join(re.escape(r) for r in sorted(EXPERT_ROLES, key=len, reverse=True)) + ")"
_QUAL = r"(?:(?:a|an|your|the|certified|licensed|board[- ]certified|registered|practicing|practising|qualified|former|trained|real|professional|senior)\s+)*"
PERSONA = [
    re.compile(r"\b(?:i\s*am|i'm|im|i've\s+been|i\s+have\s+been)\s+" + _QUAL + _ROLE + r"\b", re.I),
    re.compile(r"\b(?:as|speaking\s+as|i\s+work\s+as)\s+(?:a|an|your)\s+" + _QUAL + _ROLE + r"\b", re.I),
    re.compile(r"\b(?:this\s+is|meet|from)\s+your\s+(?:new\s+|own\s+|friendly\s+|local\s+)?" + _QUAL + _ROLE + r"\b", re.I),
    re.compile(r"\b(?:dr\.?|doctor)\s+[a-z]+\s+here\b", re.I),
    re.compile(r"\b(?:i|we)\s+(?:diagnose|prescribe|treat\s+patients|represent\s+clients|manage\s+(?:your\s+)?(?:money|portfolio|investments))\b", re.I),
    re.compile(r"(?<!not\s)(?<!n't\s)\b(?:this\s+is|here\s+is|here's|take\s+my)\s+(?:professional\s+)?(?:medical|legal|financial|investment|tax)\s+advice\b", re.I),
]
CREATURES = (r"(?:puppy|puppies|kitten|kittens|dog|dogs|cat|cats|animal|animals|baby|babies|child|children|kid|kids|"
             r"toddler|horse|bird|owl|deer|fawn|cub|cubs|calf|lamb|pet|pets|elephant|monkey|dolphin|whale|turtle|seal|fox)")
DISTRESS = (r"(?:abandoned|starving|trapped|stuck|drowning|freezing|dying|injured|wounded|bleeding|crying|screaming|"
            r"helpless|begging|whimpering|terrified|beaten|abused|tied\s+up|left\s+to\s+die|struggling\s+to\s+breathe|in\s+danger)")
RESCUE = r"(?:rescue[sd]?|rescuing|saved?|saving|saves)"
HOOKS = [
    re.compile(DISTRESS + r"\W+(?:\w+\W+){0,5}?" + CREATURES + r"\b", re.I),
    re.compile(CREATURES + r"\W+(?:\w+\W+){0,5}?" + DISTRESS + r"\b", re.I),
    re.compile(r"\b" + RESCUE + r"\W+(?:\w+\W+){0,4}?" + CREATURES + r"\b", re.I),
    re.compile(r"\b" + CREATURES + r"\W+(?:\w+\W+){0,4}?(?:gets?|got|was|is|being)\s+" + RESCUE + r"\b", re.I),
]
HOOK_WORDS = 60


def _words(text):
    return re.findall(r"[a-z0-9']+", (text or "").lower().replace("’", "'"))


def _grams(text, n=3):
    words = _words(text)
    return {tuple(words[i:i + n]) for i in range(max(0, len(words) - n + 1))}


def _jaccard(a, b):
    return len(a & b) / len(a | b) if a and b else 0.


def _script_lines(script):
    """The narration and on-screen text of a script, without the shot plan's timestamps."""
    return re.sub(r"\d{1,2}:\d{2}(?:\.\d+)?(?:\s*-\s*\d{1,2}:\d{2}(?:\.\d+)?)?", " ", script or "")


def opening(script):
    return " ".join(_words(_script_lines(script))[:OPENING_WORDS])


def persona_findings(text):
    found = []
    for pattern in PERSONA:
        match = pattern.search(text or "")
        if match:
            found.append({"check": "ai_persona", "result": "reject", "quote": match.group(0)[:120],
                          "reason": "The narrator is presented as a professional expert on health, law, money or politics "
                                    f"(\"{match.group(0)[:80]}\"). YouTube does not monetize AI personas presented as human "
                                    "experts on those topics. Present it as general information instead."})
            break
    return found


def hook_findings(title, script):
    head = " ".join([title or ""] + _script_lines(script).split()[:HOOK_WORDS])
    for pattern in HOOKS:
        match = pattern.search(head)
        if match:
            return [{"check": "distress_hook", "result": "reject", "quote": match.group(0)[:120],
                     "reason": f"The opening is a distress or rescue hook (\"{match.group(0)[:80]}\"). Content made to "
                               "distress or manipulate is not monetized and the team never makes it. Open on the idea instead."}]
    return []


def sameness_findings(store, channel_id, title, script, fmt=None, exclude_post=None):
    recent = [p for p in store.list_posts(channel_id=channel_id) if p["id"] != exclude_post][-RECENT:]
    found = []
    grams, title_words, first = _grams(_script_lines(script)), set(_words(title)), opening(script)
    for post in reversed(recent):
        theirs = _grams(_script_lines(post["script_ref"])) if script and post["script_ref"] else set()
        if len(grams) >= MIN_GRAMS and len(theirs) >= MIN_GRAMS:
            share = _jaccard(grams, theirs)
            if share >= SCRIPT_NEAR_COPY:
                found.append({"check": "sameness", "result": "reject", "post_id": post["id"], "similarity": round(share, 2),
                              "reason": f"The script is a near-copy of post {post['id']} (\"{post['title']}\"), "
                                        f"{round(share * 100)}% the same wording. Each video needs its own concept and script."})
                break
        if title and _jaccard(title_words, set(_words(post["title"]))) >= TITLE_SAME:
            found.append({"check": "sameness", "result": "reject", "post_id": post["id"],
                          "reason": f"The title is the same as post {post['id']} (\"{post['title']}\"). Give this video its own title."})
            break
        if script and post["script_ref"] and len(first.split()) >= 4 and first == opening(post["script_ref"]):
            found.append({"check": "sameness", "result": "reject", "post_id": post["id"],
                          "reason": f"It opens with the same line as post {post['id']} (\"{first}\"). Vary the opening."})
            break
    formats = [p["format"] for p in recent if p["format"]]
    if fmt and len(formats) >= 10:
        same = sum(1 for f in formats if f.lower() == fmt.lower()) + 1
        if same / (len(formats) + 1) >= FORMAT_MAJORITY:
            found.append({"check": "sameness", "result": "warn",
                          "reason": f"{same} of this channel's last {len(formats) + 1} posts use the format \"{fmt}\". "
                                    "Vary the structure, length, opening and look, not only the topic."})
    return found


def crosspost_findings(store, post):
    """Another of our channels already carries this video (same render, same script or same posted link)."""
    found = []
    mine = store.get_channel(post["channel_id"])
    for other in store.list_posts():
        if other["id"] == post["id"] or other["channel_id"] == post["channel_id"] or other["state"] == "rejected":
            continue
        theirs = store.get_channel(other["channel_id"])
        if theirs["niche_id"] == mine["niche_id"] and theirs["platform"] != mine["platform"]:
            continue    # one niche's channels on different platforms carry the same video by design
        same = ((post["render_ref"] and post["render_ref"] == other["render_ref"]) or
                (post["script_ref"] and other["script_ref"] and len(_grams(_script_lines(post["script_ref"]))) >= MIN_GRAMS and
                 _jaccard(_grams(_script_lines(post["script_ref"])), _grams(_script_lines(other["script_ref"]))) >= .9) or
                (post["posted_url"] and post["posted_url"] == other["posted_url"]))
        if same:
            found.append({"check": "cross_post", "result": "reject", "post_id": other["id"],
                          "reason": f"The same video is already post {other['id']} on {theirs['platform']} channel "
                                    f"{theirs['handle']}. The team never posts one video on two of its own channels."})
            break
    return found


# -- ported formats (build unit 2) ---------------------------------------------------------------------------------

SERIES_LOOKBACK = 5        # the last episodes of one format on a channel compared for the same concept
SERIES_SAME = .5           # share of content words two concepts have in common at which they are the same concept
SOURCE_TITLE_SAME = .6     # share of title words at which a title could be mistaken for a source video's
PREMISE_REWORD = .8
_STOP = {"a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "is", "are", "be", "you", "your", "it", "its", "this",
         "that", "with", "at", "by", "from", "as", "how", "why", "what", "if", "we", "our", "i", "my", "can", "could"}


def _content(text):
    return {w for w in _words(text) if w not in _STOP and len(w) > 1}


def _named(text, name):
    return re.search(r"(?<![a-z0-9])" + re.escape(name.lower()) + r"(?![a-z0-9])", (text or "").lower()) is not None


def distance_findings(card, fields):
    """fields: {label: text} of ours (title, thumbnail, mascot, premise, script). Nothing of the source's may be in them."""
    found = []
    for label, text in fields.items():
        if not text:
            continue
        hit = next((n for n in card["do_not_use"] if _named(text, n)), None)
        if hit:
            found.append({"check": "distance", "result": "reject", "field": label, "quote": hit,
                          "reason": f"The {label} uses \"{hit}\", which belongs to the source (format card \"{card['name']}\"). "
                                    "The structure may be reused; names, mascots, artwork and lines may not."})
    title = fields.get("title") or ""
    mine = set(_words(title))
    for row in card["evidence"]:
        if title and row.get("title") and _jaccard(mine, set(_words(row["title"]))) >= SOURCE_TITLE_SAME:
            found.append({"check": "distance", "result": "reject", "field": "title", "quote": row["title"][:120],
                          "reason": f"The title \"{title}\" could be mistaken for the source video \"{row['title']}\" "
                                    f"on {row['channel']}. Word it our own way."})
            break
    premise = fields.get("premise")
    if premise and _jaccard(set(_words(premise)), set(_words(card["premise"]))) >= PREMISE_REWORD:
        found.append({"check": "distance", "result": "warn", "field": "premise",
                      "reason": "The premise is worded almost as the card's. Give the port its own wording for the new niche."})
    return found


def _concept(store, post):
    if post.get("topic_id"):
        return store.get_topic(post["topic_id"])["title"]
    return post["title"]


def _pattern(store, format_id):
    """The words every episode of a format shares by design (the card's and its ports' premises), left out of a concept."""
    card = store.get_format(format_id)
    return _content(" ".join([card["premise"]] + [p["premise"] for p in store.list_ports(format_id=format_id)]))


def series_findings(store, channel_id, format_id, concept, exclude_post=None):
    """Each episode of a format is its own concept: the channel's last episodes of it must not share this one's.
    The words of the format's own premise do not count, so a series title pattern is not a shared concept."""
    episodes = [p for p in store.list_posts(channel_id=channel_id) if p["format_id"] == format_id
                and p["id"] != exclude_post and p["state"] != "rejected"][-SERIES_LOOKBACK:]
    shared = _pattern(store, format_id)
    mine = _content(concept) - shared
    for post in reversed(episodes):
        theirs = _content(_concept(store, post)) - shared
        if mine and theirs and _jaccard(mine, theirs) >= SERIES_SAME:
            return [{"check": "series", "result": "reject", "post_id": post["id"],
                     "reason": f"Episode {post['id']} (\"{post['title']}\") had the same concept. Each episode of a series "
                               "needs its own concept, research and script, never the same setup with the same outcome."}]
    return []


def port_findings(store, port, today=None):
    """The Evaluator's checks on a port proposal: audience match, distance from the source, cost to make, series rule."""
    from . import formats
    card = store.get_format(port["format_id"])
    found = []
    # 1. Audience match, stated with evidence.
    if len(_words(port["audience_match"])) < 6:
        found.append({"check": "audience_match", "result": "reject",
                      "reason": "Say why the audiences match in a full sentence: who they are, what they watch and where."})
    stale = [e for e in port["audience_evidence"] + card["evidence"] if formats.is_stale(e["checked"], today)]
    if stale:
        found.append({"check": "audience_match", "result": "warn",
                      "reason": f"{len(stale)} evidence row(s) were checked more than {formats.STALE_DAYS} days ago. Check them again."})
    platforms = {c["platform"] for c in store.list_channels(niche_id=port["niche_id"], status="live")}
    if card["audience"].get("platform") not in platforms:
        found.append({"check": "audience_match", "result": "warn",
                      "reason": f"The source audience watches on {card['audience'].get('platform')}, and {port['niche_name']} has no "
                                "live channel there."})
    # 2. Distance from the source.
    found += distance_findings(card, {"title": port["example_title"], "thumbnail": port["thumbnail"], "mascot": port["mascot"],
                                      "premise": port["premise"], "subject": port["subject"]})
    # 3. Cost to make in the chosen pack.
    pack = formats.all_packs().get(port["style_pack"])
    if pack is None:
        return {"ok": False, "findings": found + [{"check": "cost", "result": "reject",
                                                  "reason": "The port's style pack is no longer in this account."}], "cost": None}
    typical = (card["length_min_s"] + card["length_max_s"]) / 2
    cost = formats.cost(port["style_pack"], min(typical, pack["max_seconds"]), port.get("renderer"))
    if not pack["available"]:
        found.append({"check": "cost", "result": "reject", "reason": f"{pack['name']} cannot be made yet. {pack['note']}"})
    elif card["length_min_s"] > pack["max_seconds"]:
        found.append({"check": "cost", "result": "reject",
                      "reason": f"The format runs at least {card['length_min_s'] / 60:.0f} minutes; {pack['name']} makes up to "
                                f"{pack['max_seconds'] / 60:.0f} minutes today."})
    elif card["length_max_s"] > pack["max_seconds"]:
        found.append({"check": "cost", "result": "warn",
                      "reason": f"Keep episodes under {pack['max_seconds'] / 60:.0f} minutes: that is what {pack['name']} makes today."})
    if cost["ratio"] and cost["ratio"] >= formats.COST_WARN_RATIO:
        found.append({"check": "cost", "result": "warn",
                      "reason": f"{pack['name']} costs about {cost['ratio']:.0f} times the cheapest pack that could make this. "
                                "Pick it only if the look is worth that."})
    # 4. Series rule: the example episode against what this format already made in the niche.
    for channel in store.list_channels(niche_id=port["niche_id"], status="live"):
        hit = series_findings(store, channel["id"], card["id"], f"{port['subject']} {port['example_title']}")
        if hit:
            found += hit
            break
    return {"ok": not any(f["result"] == "reject" for f in found), "findings": found, "cost": cost}


def check(store, post_id, title=None, script=None, fmt=None):
    """Every policy check on a post, or on a draft of it (title, script, format not yet saved)."""
    post = store.get_post(post_id)
    title = post["title"] if title is None else title
    script = post["script_ref"] if script is None else script
    fmt = post["format"] if fmt is None else fmt
    findings = []
    findings += persona_findings(" ".join([title or "", post["caption"] or "", script or ""]))
    findings += hook_findings(title, script)
    findings += sameness_findings(store, post["channel_id"], title, script, fmt, exclude_post=post_id)
    findings += crosspost_findings(store, {**post, "title": title, "script_ref": script})
    if post.get("format_id"):
        card = store.get_format(post["format_id"])
        findings += distance_findings(card, {"title": title, "thumbnail": post.get("thumbnail"), "script": script})
        concept = store.get_topic(post["topic_id"])["title"] if post.get("topic_id") else title
        findings += series_findings(store, post["channel_id"], post["format_id"], concept, exclude_post=post_id)
    if not post.get("ai_label", 1):
        findings.append({"check": "ai_label", "result": "reject", "reason": "The AI label is off; every post carries it."})
    return {"ok": not any(f["result"] == "reject" for f in findings), "findings": findings}


def reasons(result):
    return " ".join(f["reason"] for f in result["findings"] if f["result"] == "reject")
