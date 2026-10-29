"""Routine schedules (core/bot_schedules.py): the cron parser, the DST resolver,
interval windows and the plain sentences. Pure functions, a fake clock, no
files. Run: .venv\\Scripts\\python.exe -B -X utf8 scripts\\test_bots_schedules.py
"""
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import bot_schedules as bs  # noqa: E402

NY = "America/New_York"


def utc(*args) -> float:
    return datetime(*args, tzinfo=timezone.utc).timestamp()


def times(schedule, after, count=3):
    return [m.isoformat() for m in bs.next_times(schedule, after, count)]


class CronParsing(unittest.TestCase):
    def test_five_fields_lists_ranges_steps_names(self):
        cron = bs.parse_cron("0,30 9-17/4 1,15 jan,JUL mon-fri")
        self.assertEqual(cron.minutes, (0, 30))
        self.assertEqual(cron.hours, (9, 13, 17))
        self.assertEqual(cron.months, frozenset({1, 7}))
        self.assertEqual(cron.weekdays, frozenset({0, 1, 2, 3, 4}))

    def test_sunday_converts_to_the_kairos_convention(self):
        # Cron counts Sunday as 0 or 7; Kairos counts Monday as 0 and Sunday as 6.
        self.assertEqual(bs.cron_weekday_to_kairos(0), 6)
        self.assertEqual(bs.cron_weekday_to_kairos(7), 6)
        self.assertEqual(bs.cron_weekday_to_kairos(1), 0)
        self.assertEqual(bs.parse_cron("0 9 * * 0").weekdays, frozenset({6}))
        self.assertEqual(bs.parse_cron("0 9 * * 7").weekdays, frozenset({6}))
        self.assertEqual(bs.parse_cron("0 9 * * SUN").weekdays, frozenset({6}))
        self.assertEqual(bs.parse_cron("0 9 * * 5-7").weekdays, frozenset({4, 5, 6}))
        sunday = bs.normalize({"kind": "cron", "expression": "0 9 * * 0", "time_zone": "UTC"}, now=utc(2026, 10, 28))
        self.assertEqual(times(sunday, utc(2026, 10, 28), 1), ["2026-11-01T09:00:00+00:00"])  # a Sunday

    def test_unsupported_syntax_names_the_field(self):
        cases = {
            "* * * * * *": "expression",  # six fields: seconds
            "@daily": "expression",
            "0 9 * *": "expression",
            "60 9 * * *": "minute",
            "0 24 * * *": "hour",
            "0 9 32 * *": "day of month",
            "0 9 * 13 *": "month",
            "0 9 * * 8": "day of week",
            "0 9 * * L": "day of week",
            "0 9 ? * *": "day of month",
            "0 9 1#2 * *": "day of month",
            "5-1 9 * * *": "minute",
            "*/0 9 * * *": "minute",
            "0 9 15W * *": "day of month",
            "": "expression",
        }
        for expression, field in cases.items():
            with self.assertRaises(bs.ScheduleError, msg=expression) as caught:
                bs.parse_cron(expression)
            self.assertEqual(caught.exception.field, field, expression)

    def test_length_limit(self):
        with self.assertRaises(bs.ScheduleError):
            bs.parse_cron("0 9 * * *" + " " * 5 + "x" * 300)

    def test_last_day_of_month(self):
        cron = bs.parse_cron("0 9 L * *")
        found = bs.cron_after(cron, bs.zone_of("UTC"), datetime(2028, 1, 15, tzinfo=timezone.utc), 4)
        self.assertEqual([m.strftime("%Y-%m-%d") for m in found], ["2028-01-31", "2028-02-29", "2028-03-31", "2028-04-30"])

    def test_day_of_month_and_weekday_together_mean_either(self):
        cron = bs.parse_cron("0 9 13 * 5")  # the 13th, or any Friday
        found = bs.cron_after(cron, bs.zone_of("UTC"), datetime(2026, 11, 1, tzinfo=timezone.utc), 5)
        self.assertEqual([m.strftime("%m-%d") for m in found], ["11-06", "11-13", "11-20", "11-27", "12-04"])

    def test_sparse_invalid_cron_is_rejected(self):
        for expression in ("0 0 31 2 *", "0 0 30 2 *", "0 0 31 4,6,9,11 *"):
            with self.assertRaises(bs.ScheduleError, msg=expression) as caught:
                bs.normalize({"kind": "cron", "expression": expression, "time_zone": "UTC"}, now=utc(2026, 1, 1))
            self.assertIn("never runs", caught.exception.message)
        leap = bs.normalize({"kind": "cron", "expression": "0 0 29 2 *", "time_zone": "UTC"}, now=utc(2026, 1, 1))
        self.assertEqual(times(leap, utc(2026, 1, 1), 1), ["2028-02-29T00:00:00+00:00"])

    def test_cron_needs_a_named_zone(self):
        with self.assertRaises(bs.ScheduleError) as caught:
            bs.normalize({"kind": "cron", "expression": "0 9 * * *"})
        self.assertEqual(caught.exception.field, "time_zone")
        with self.assertRaises(bs.ScheduleError) as caught:
            bs.normalize({"kind": "cron", "expression": "0 9 * * *", "time_zone": "Mars/Base"})
        self.assertEqual(caught.exception.field, "time_zone")


class DaylightSaving(unittest.TestCase):
    def test_spring_forward_gap_advances_by_the_gap(self):
        # 2026-03-08 02:30 does not exist in New York; the run happens at 03:30 EDT.
        cron = bs.normalize({"kind": "cron", "expression": "30 2 * * *", "time_zone": NY}, now=utc(2026, 3, 7, 12))
        self.assertEqual(times(cron, utc(2026, 3, 7, 12), 3),
                         ["2026-03-08T07:30:00+00:00", "2026-03-09T06:30:00+00:00", "2026-03-10T06:30:00+00:00"])
        daily = {"kind": "daily", "time": "02:30", "time_zone": NY}
        self.assertEqual(times(daily, utc(2026, 3, 7, 12), 1), ["2026-03-08T07:30:00+00:00"])

    def test_fall_back_repeated_time_uses_the_first(self):
        # 2026-11-01 01:30 happens twice in New York; only the first (EDT) counts.
        cron = bs.normalize({"kind": "cron", "expression": "30 1 * * *", "time_zone": NY}, now=utc(2026, 10, 31, 12))
        found = times(cron, utc(2026, 10, 31, 12), 3)
        self.assertEqual(found[0], "2026-11-01T05:30:00+00:00")  # 01:30 EDT, the first one
        self.assertEqual(found[1], "2026-11-02T06:30:00+00:00")  # next day 01:30 EST
        self.assertEqual(len(set(found)), 3)

    def test_a_gap_and_the_next_hour_do_not_run_twice(self):
        cron = bs.normalize({"kind": "cron", "expression": "0 2,3 * * *", "time_zone": NY}, now=utc(2026, 3, 7, 12))
        found = times(cron, utc(2026, 3, 8, 0), 2)
        self.assertEqual(found[0], "2026-03-08T07:00:00+00:00")  # 02:00 -> 03:00 EDT
        self.assertNotEqual(found[0], found[1])

    def test_daily_after_dst_keeps_the_wall_clock(self):
        daily = {"kind": "daily", "time": "09:00", "time_zone": NY}
        self.assertEqual(times(daily, utc(2026, 10, 31, 12), 2),
                         ["2026-10-31T13:00:00+00:00", "2026-11-01T14:00:00+00:00"])  # 09:00 EDT, then 09:00 EST
        self.assertEqual(times(daily, utc(2026, 3, 7, 18), 2),
                         ["2026-03-08T13:00:00+00:00", "2026-03-09T13:00:00+00:00"])


class Daily(unittest.TestCase):
    def test_weekdays_use_monday_zero(self):
        schedule = bs.normalize({"kind": "daily", "time": "08:00", "weekdays": [5, 6], "time_zone": "UTC"})
        # 2026-10-29 is a Thursday: the next Saturday is 10-31, then Sunday 11-01.
        self.assertEqual(times(schedule, utc(2026, 10, 29), 3),
                         ["2026-10-31T08:00:00+00:00", "2026-11-01T08:00:00+00:00", "2026-11-07T08:00:00+00:00"])

    def test_validation(self):
        for raw in ({"kind": "daily", "time": "25:00"}, {"kind": "daily", "time": "9"},
                    {"kind": "daily", "time": "09:00", "weekdays": [7]}, {"kind": "daily", "time": "09:00", "time_zone": "x/y"}):
            with self.assertRaises(bs.ScheduleError, msg=str(raw)):
                bs.normalize(raw)


class Intervals(unittest.TestCase):
    base = {"kind": "interval", "every_minutes": 60, "anchor_at": "2026-10-29T08:00:00+00:00", "time_zone": "UTC"}

    def test_plain_grid_from_the_anchor(self):
        schedule = bs.normalize(self.base, now=utc(2026, 10, 29, 7))
        self.assertEqual(times(schedule, utc(2026, 10, 29, 7), 2), ["2026-10-29T08:00:00+00:00", "2026-10-29T09:00:00+00:00"])
        self.assertEqual(times(schedule, utc(2026, 10, 29, 9, 0, 1), 1), ["2026-10-29T10:00:00+00:00"])
        self.assertEqual(times(schedule, utc(2026, 10, 29, 8), 1), ["2026-10-29T09:00:00+00:00"], "strictly after")

    def test_cadence_bounds(self):
        for every in (4, 1441, 0, "5"):
            with self.assertRaises(bs.ScheduleError, msg=str(every)):
                bs.normalize({**self.base, "every_minutes": every})
        bs.normalize({**self.base, "every_minutes": 5})
        bs.normalize({**self.base, "every_minutes": 1440})

    def test_window_is_end_exclusive_and_restarts_each_day(self):
        schedule = bs.normalize({**self.base, "every_minutes": 30, "window": {"start": "09:00", "end": "10:30"}},
                                now=utc(2026, 10, 29, 7))
        found = times(schedule, utc(2026, 10, 29, 7), 5)
        self.assertEqual(found, ["2026-10-29T09:00:00+00:00", "2026-10-29T09:30:00+00:00", "2026-10-29T10:00:00+00:00",
                                 "2026-10-30T09:00:00+00:00", "2026-10-30T09:30:00+00:00"])
        self.assertNotIn("2026-10-29T10:30:00+00:00", found)

    def test_window_rules(self):
        for window in ({"start": "22:00", "end": "06:00"}, {"start": "09:00", "end": "09:00"},
                       {"start": "09:00", "end": "09:30"}):  # shorter than the cadence
            with self.assertRaises(bs.ScheduleError, msg=str(window)) as caught:
                bs.normalize({**self.base, "window": window})
            self.assertEqual(caught.exception.field, "window")
        bs.normalize({**self.base, "window": {"start": "09:00", "end": "10:00"}})  # exactly one cadence

    def test_weekdays_and_end(self):
        schedule = bs.normalize({**self.base, "every_minutes": 720, "weekdays": [0],
                                 "ends_at": "2026-11-09T00:00:00+00:00"}, now=utc(2026, 10, 29, 7))
        found = times(schedule, utc(2026, 10, 29, 7), 10)
        self.assertEqual(found, ["2026-11-02T08:00:00+00:00", "2026-11-02T20:00:00+00:00",
                                 "2026-11-09T00:00:00+00:00"][:len(found)])
        self.assertTrue(all(datetime.fromisoformat(t) <= datetime(2026, 11, 9, tzinfo=timezone.utc) for t in found))
        with self.assertRaises(bs.ScheduleError):
            bs.normalize({**self.base, "ends_at": "2026-10-29T07:00:00+00:00"})

    def test_ends_at_is_the_last_moment_a_run_may_start(self):
        schedule = bs.normalize({**self.base, "ends_at": "2026-10-29T10:00:00+00:00"}, now=utc(2026, 10, 29, 7))
        self.assertEqual(times(schedule, utc(2026, 10, 29, 7), 5),
                         ["2026-10-29T08:00:00+00:00", "2026-10-29T09:00:00+00:00", "2026-10-29T10:00:00+00:00"])

    def test_window_across_spring_forward(self):
        schedule = bs.normalize({"kind": "interval", "every_minutes": 60, "anchor_at": "2026-03-07T00:00:00+00:00",
                                 "window": {"start": "01:00", "end": "05:00"}, "time_zone": NY}, now=utc(2026, 3, 7))
        found = times(schedule, utc(2026, 3, 8, 0), 4)
        self.assertEqual(found[0], "2026-03-08T06:00:00+00:00")  # 01:00 EST
        self.assertEqual(len(found), 4)
        self.assertEqual(sorted(found), found)


class OnceAndReset(unittest.TestCase):
    def test_once_rejects_the_past_and_runs_once(self):
        with self.assertRaises(bs.ScheduleError):
            bs.normalize({"kind": "once", "at": "2026-01-01T00:00:00Z"}, now=utc(2026, 10, 29))
        schedule = bs.normalize({"kind": "once", "at": "2026-11-02T09:00:00-05:00"}, now=utc(2026, 10, 29))
        self.assertEqual(times(schedule, utc(2026, 10, 29), 3), ["2026-11-02T14:00:00+00:00"])
        self.assertEqual(times(schedule, utc(2026, 11, 3), 3), [])

    def test_limit_reset_is_the_reset_plus_sixty_seconds(self):
        schedule = bs.normalize({"kind": "limit_reset", "endpoint_id": "ep1", "repeat": "every_reset"})
        reset = utc(2026, 10, 29, 15, 40)
        self.assertEqual([m.isoformat() for m in bs.next_times(schedule, reset - 100, 1, reset)], ["2026-10-29T15:41:00+00:00"])
        self.assertEqual(bs.next_times(schedule, reset + 100, 1, reset), [])
        self.assertEqual(bs.next_times(schedule, reset - 100, 1, None), [], "no known reset, no time")
        with self.assertRaises(bs.ScheduleError):
            bs.normalize({"kind": "limit_reset", "endpoint_id": "", "repeat": "once"})
        with self.assertRaises(bs.ScheduleError):
            bs.normalize({"kind": "limit_reset", "endpoint_id": "x", "repeat": "forever"})


class BetweenAndPreview(unittest.TestCase):
    def test_occurrences_between(self):
        schedule = {"kind": "interval", "every_minutes": 60, "anchor_at": "2026-10-29T00:00:00+00:00", "time_zone": "UTC"}
        found = bs.occurrences_between(schedule, utc(2026, 10, 29, 0, 30), utc(2026, 10, 29, 5), limit=100)
        self.assertEqual([m.hour for m in found], [1, 2, 3, 4, 5], "the end is included")
        self.assertEqual(len(bs.occurrences_between(schedule, utc(2026, 10, 29), utc(2026, 12, 1), limit=30)), 30)

    def test_sentences(self):
        self.assertEqual(bs.describe({"kind": "daily", "time": "09:00", "weekdays": [0, 1, 2, 3, 4],
                                      "time_zone": "America/Los_Angeles"}), "Every weekday at 9 AM Pacific time")
        self.assertEqual(bs.describe({"kind": "daily", "time": "18:30", "time_zone": None}), "Every day at 6:30 PM")
        self.assertEqual(bs.describe({"kind": "interval", "every_minutes": 15, "time_zone": None}), "Every 15 minutes")
        self.assertEqual(bs.describe({"kind": "interval", "every_minutes": 120, "time_zone": None,
                                      "window": {"start": "09:00", "end": "17:00"}}), "Every 2 hours between 9 AM and 5 PM")
        self.assertEqual(bs.describe({"kind": "cron", "expression": "0 9 * * 1-5", "time_zone": NY}),
                         "Every weekday at 9 AM Eastern time")
        self.assertEqual(bs.describe({"kind": "cron", "expression": "0 9 L * *", "time_zone": "UTC"}),
                         "On the schedule 0 9 L * * UTC")
        self.assertEqual(bs.describe({"kind": "limit_reset", "endpoint_id": "e", "repeat": "once"}),
                         "When the usage limit resets")
        for text in (bs.describe({"kind": "daily", "time": "09:00", "weekdays": [0, 2], "time_zone": None}),):
            self.assertNotIn("—", text)

    def test_preview_has_sentence_and_next_three(self):
        schedule = bs.normalize({"kind": "cron", "expression": "*/20 * * * *", "time_zone": "UTC"}, now=utc(2026, 10, 29))
        shown = bs.preview(schedule, utc(2026, 10, 29, 0, 5))
        self.assertEqual(shown["sentence"], "Every 20 minutes UTC")
        self.assertEqual(shown["next"], ["2026-10-29T00:20:00+00:00", "2026-10-29T00:40:00+00:00", "2026-10-29T01:00:00+00:00"])

    def test_the_watch_routine_fits(self):
        # Phase 5's "Keep an eye on my day": every 15 minutes, no window.
        watch = bs.normalize({"kind": "interval", "every_minutes": 15, "anchor_at": "2026-10-29T12:15:00+00:00"},
                             now=utc(2026, 10, 29, 12))
        self.assertEqual(times(watch, utc(2026, 10, 29, 12), 2), ["2026-10-29T12:15:00+00:00", "2026-10-29T12:30:00+00:00"])

    def test_legacy_translation(self):
        daily = bs.from_legacy({"schedule_kind": "daily", "run_time": "06:00", "time_zone": NY, "weekdays": [0, 4]})
        self.assertEqual(daily, {"kind": "daily", "time": "06:00", "time_zone": NY, "weekdays": [0, 4]})
        interval = bs.from_legacy({"schedule_kind": "interval", "interval_seconds": 3600,
                                   "next_run_at": "2026-10-29T10:00:00+00:00"})
        self.assertEqual(interval["every_minutes"], 60)
        self.assertEqual(bs.legacy_fields({"kind": "cron", "expression": "0 9 * * *", "time_zone": "UTC"})["schedule_kind"], "cron")


if __name__ == "__main__":
    unittest.main()
