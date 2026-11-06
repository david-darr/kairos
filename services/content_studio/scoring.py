"""The score (spec section 5, D2): pure maths, no storage.

Per post: 40% views at 7 days, 40% watch share (average view duration / video length), 20% follows plus
engagement. Each part is RANKED among the posts of the same platform (a TikTok view is not a YouTube view),
then the three ranks are mixed with the team's weights into a 0-100 score. A niche, format or strategy is the
mean of its posts' scores, and is judged only once it has the minimum data.
"""
DAY = 86400.0
SNAPSHOT_TOLERANCE_DAYS = 2.0  # a "7 day" number must be taken within this of the 7 day mark, or the post is not scored yet


def median(values):
    ordered = sorted(values)
    n = len(ordered)
    if not n:
        return None
    mid = n // 2
    return ordered[mid] if n % 2 else (ordered[mid - 1] + ordered[mid]) / 2


def rank_pct(values):
    """Each value's place among the others as 0 (lowest) to 1 (highest); ties share the average place.
    A lone value has nothing to be ranked against and sits in the middle."""
    n = len(values)
    if n == 1:
        return [0.5]
    order = sorted(range(n), key=lambda i: values[i])
    out = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and values[order[j + 1]] == values[order[i]]:
            j += 1
        average_place = (i + j) / 2  # zero-based
        for k in range(i, j + 1):
            out[order[k]] = average_place / (n - 1)
        i = j + 1
    return out


def seven_day_snapshot(posted_at, snapshots, days=7, tolerance_days=SNAPSHOT_TOLERANCE_DAYS):
    """The snapshot nearest the 7 day mark, if one was taken close enough to it."""
    target = posted_at + days * DAY
    best = None
    for snap in snapshots:
        gap = abs(snap["taken_at"] - target)
        if gap <= tolerance_days * DAY and (best is None or gap < best[0]):
            best = (gap, snap)
    return best[1] if best else None


def post_parts(snap, follow_weight=5):
    """The three raw numbers a post is ranked on."""
    length = snap["video_length_s"]
    watch = min(1.0, snap["avg_view_duration_s"] / length) if length > 0 else 0.0
    views = snap["views"]
    engagement = (snap["likes"] + snap["comments"] + snap["shares"] + follow_weight * snap["follows_gained"]) / max(views, 1)
    return {"views": float(views), "watch": watch, "engagement": engagement}


def score_posts(items, weights):
    """items: [{id, platform, views, watch, engagement}] -> {id: {score, views_pct, watch_pct, engagement_pct}}.
    Ranked within each platform, mixed with the weights (any non-negative numbers; they are normalised)."""
    total = sum(weights.values())
    if total <= 0:
        raise ValueError("weights must add up to more than zero")
    by_platform = {}
    for item in items:
        by_platform.setdefault(item["platform"], []).append(item)
    out = {}
    for group in by_platform.values():
        pcts = {part: rank_pct([item[part] for item in group]) for part in ("views", "watch", "engagement")}
        for index, item in enumerate(group):
            mix = sum(weights[part] * pcts[part][index] for part in ("views", "watch", "engagement")) / total
            out[item["id"]] = {"score": round(100 * mix, 4), "views_pct": pcts["views"][index],
                               "watch_pct": pcts["watch"][index], "engagement_pct": pcts["engagement"][index]}
    return out


def group_table(posted, scored, key_of, now, min_weeks, min_posts):
    """One row per group (niche, format or strategy).

    posted: every posted post (dicts with id, posted_at); scored: {post_id: score row} for those that have 7 day numbers;
    key_of(post) -> group key or None. Eligible = at least min_posts scored posts and the first post at least
    min_weeks old; its score is then the mean of the scored posts."""
    table = {}
    for post in posted:
        key = key_of(post)
        if key is None:
            continue
        row = table.setdefault(key, {"key": key, "posts_posted": 0, "posts_scored": 0, "first_posted_at": None, "_scores": []})
        row["posts_posted"] += 1
        first = row["first_posted_at"]
        row["first_posted_at"] = post["posted_at"] if first is None else min(first, post["posted_at"])
        if post["id"] in scored:
            row["posts_scored"] += 1
            row["_scores"].append(scored[post["id"]]["score"])
    for row in table.values():
        scores = row.pop("_scores")
        row["score"] = round(sum(scores) / len(scores), 4) if scores else None
        age_days = (now - row["first_posted_at"]) / DAY
        row["age_days"] = round(age_days, 2)
        reasons = []
        if row["posts_scored"] < min_posts:
            reasons.append(f"{row['posts_scored']} of {min_posts} posts with 7 day numbers")
        if age_days < min_weeks * 7:
            reasons.append(f"{age_days:.0f} of {min_weeks * 7} days")
        row["eligible"] = not reasons
        row["not_yet"] = "; ".join(reasons)
    return table
