"""The Calendar editor's bounded daily/weekly/monthly repeat rules.

Local instances use calendar dates in an IANA zone, never 24-hour UTC jumps.
Missing monthly dates and nonexistent DST wall times are skipped, as RRULEs
are. Google continues to own expansion of its own recurring events.
"""
import calendar
import re
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

FREQUENCIES = {"daily": "DAILY", "weekly": "WEEKLY", "monthly": "MONTHLY"}


def zone(name):
    try:
        return ZoneInfo(name or "UTC")
    except (ZoneInfoNotFoundError, TypeError, ValueError) as exc:
        raise ValueError("Enter a valid IANA time zone, such as America/New_York") from exc


def stamp(value, time_zone="UTC"):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=zone(time_zone)) if parsed.tzinfo is None else parsed
    except (TypeError, AttributeError, ValueError) as exc:
        raise ValueError("Enter a valid ISO event date/time") from exc


def day(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("Enter a date as YYYY-MM-DD")
    return date.fromisoformat(value)


def normalize(rule, start, time_zone="UTC", all_day=False):
    if rule is None:
        return None
    if not isinstance(rule, dict) or set(rule) - {"frequency", "interval", "until", "count"}:
        raise ValueError("Choose a daily, weekly or monthly repeat rule")
    frequency = rule.get("frequency")
    interval = rule.get("interval", 1)
    count, until = rule.get("count"), rule.get("until")
    if not isinstance(frequency, str) or frequency not in FREQUENCIES or type(interval) is not int or not 1 <= interval <= 365:
        raise ValueError("Repeat every 1 to 365 days, weeks or months")
    if count is not None and (type(count) is not int or not 1 <= count <= 10000):
        raise ValueError("Repeat count must be from 1 to 10000")
    if count is not None and until is not None:
        raise ValueError("Choose an end date or a repeat count, not both")
    anchor = day(start) if all_day else stamp(start, time_zone).astimezone(zone(time_zone)).date()
    if until is not None and day(until) < anchor:
        raise ValueError("Repeat end date cannot be before the first event")
    return {"frequency": frequency, "interval": interval,
            **({"count": count} if count is not None else {}),
            **({"until": until} if until is not None else {})}


def boundaries(event):
    tz = zone(event.get("time_zone"))
    if event["all_day"]:
        first, end = day(event["start"]), day(event["end"])
    else:
        first = stamp(event["start"], event.get("time_zone")).astimezone(tz)
        end = stamp(event["end"], event.get("time_zone")).astimezone(tz)
    if end <= first:
        raise ValueError("The event must end after it starts")
    return first, end


def _valid_wall(value):
    # ZoneInfo attaches an offset to even a nonexistent spring-forward time.
    return value.astimezone(timezone.utc).astimezone(value.tzinfo).replace(tzinfo=None) == value.replace(tzinfo=None)


def occurrences(event, first_date, last_date):
    """Yield valid starts touching an inclusive date span, without storing copies.

    The generator seeks straight to daily/weekly dates when no COUNT needs
    counting. COUNT counts emitted events; skipped monthly/DST dates do not count.
    """
    first, end = boundaries(event)
    anchor = first if event["all_day"] else first.date()
    duration = end - first
    lower = day(first_date) - timedelta(days=max(0, duration.days) + 1)
    upper = day(last_date)
    rule = event["recurrence"]
    until = day(rule["until"]) if rule.get("until") else date.max
    upper = min(upper, until)
    if upper < anchor:
        return
    frequency, interval = rule["frequency"], rule["interval"]
    step = interval * (7 if frequency == "weekly" else 1)
    index = 0
    if not rule.get("count") and frequency != "monthly":
        index = max(0, (lower - anchor).days // step)
    emitted = 0
    for _ in range(120000):  # at most the entire supported datetime calendar
        try:
            if frequency == "monthly":
                month = anchor.year * 12 + anchor.month - 1 + index * interval
                year, month0 = divmod(month, 12)
                if year > upper.year or (year == upper.year and month0 + 1 > upper.month):
                    break
                if anchor.day > calendar.monthrange(year, month0 + 1)[1]:
                    index += 1
                    continue
                current = date(year, month0 + 1, anchor.day)
            else:
                current = anchor + timedelta(days=index * step)
        except (OverflowError, ValueError):
            break
        if current > upper:
            break
        index += 1
        starts = current if event["all_day"] else datetime.combine(current, first.timetz()).replace(fold=0)
        ends = starts + duration
        if not event["all_day"] and (not _valid_wall(starts) or not _valid_wall(ends)):
            continue
        emitted += 1
        if rule.get("count") and emitted > rule["count"]:
            break
        if current < lower:
            continue
        yield current.isoformat(), starts.isoformat(), ends.isoformat()


def google_rule(rule, start, time_zone="UTC", all_day=False):
    rule = normalize(rule, start, time_zone, all_day)
    if rule is None:
        return []
    text = f"RRULE:FREQ={FREQUENCIES[rule['frequency']]};INTERVAL={rule['interval']}"
    if rule.get("count"):
        text += f";COUNT={rule['count']}"
    if rule.get("until"):
        until = day(rule["until"])
        if all_day:
            text += ";UNTIL=" + until.strftime("%Y%m%d")
        else:
            end = datetime.combine(until, time(23, 59, 59), zone(time_zone)).astimezone(timezone.utc)
            text += ";UNTIL=" + end.strftime("%Y%m%dT%H%M%SZ")
    return [text]


def parse_google_rule(lines, start, time_zone="UTC", all_day=False):
    """None means one-off; False means remote rules the simple editor preserves."""
    if not lines:
        return None
    try:
        if not isinstance(lines, list) or len(lines) != 1 or not isinstance(lines[0], str) or not lines[0].startswith("RRULE:"):
            return False
        pairs = [part.split("=", 1) for part in lines[0][6:].split(";")]
        fields = dict(pairs)
        if len(pairs) != len(fields) or set(fields) - {"FREQ", "INTERVAL", "COUNT", "UNTIL"}:
            return False
        reverse = {value: key for key, value in FREQUENCIES.items()}
        rule = {"frequency": reverse[fields["FREQ"]], "interval": int(fields.get("INTERVAL", "1"))}
        if "COUNT" in fields:
            rule["count"] = int(fields["COUNT"])
        if "UNTIL" in fields:
            value = fields["UNTIL"]
            if all_day:
                rule["until"] = datetime.strptime(value, "%Y%m%d").date().isoformat()
            else:
                end = datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc).astimezone(zone(time_zone))
                # The editor only represents inclusive dates, not arbitrary cutoffs.
                if end.time() != time(23, 59, 59):
                    return False
                rule["until"] = end.date().isoformat()
        return normalize(rule, start, time_zone, all_day)
    except (ValueError, TypeError, KeyError, IndexError):
        return False
