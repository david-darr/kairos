"""A03: the Home week across daylight-saving changes and real-data edge cases.
Uses the machine's local zone (the week is grouped by server-local days); the
DST cases skip themselves when the zone has no DST in 2026.
Run: python scripts/test_g1_home_week_dst.py"""
import os
import sys
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_home_week as base  # noqa: E402  (sets up the isolated data dir)
from core import session_manager_store as store  # noqa: E402
from core.atomic_io import write_json_atomic  # noqa: E402
from services.task_service import tasks_file, runs_file  # noqa: E402

stamp = base.stamp


def local_day_hours(day):
    return (datetime.fromisoformat(f'{day}T23:59:59').timestamp() - datetime.fromisoformat(f'{day}T00:00:00').timestamp() + 1) / 3600


class DstWeek(base.unittest.IsolatedAsyncioTestCase):
    asyncSetUp = base.WeekTests.asyncSetUp
    asyncTearDown = base.WeekTests.asyncTearDown
    session = base.WeekTests.session
    week = base.WeekTests.week

    async def test_fall_back_week_keeps_seven_days_and_am_pm_edges(self):
        if round(local_day_hours('2026-11-01')) != 25:
            self.skipTest('local zone has no fall-back on 2026-11-01')
        # Week of Mon 2026-10-26 .. Sun 2026-11-01 holds the 25-hour Sunday.
        self.session('a', 'alice', [('user', stamp('2026-10-25', 23, 59)), ('user', stamp('2026-10-26', 0, 0)),
                                    ('user', stamp('2026-11-01', 0, 30)), ('user', stamp('2026-11-01', 11, 59)),
                                    ('user', stamp('2026-11-01', 12, 0)), ('user', stamp('2026-11-01', 23, 59)),
                                    ('user', stamp('2026-11-02', 0, 0))])
        data = await self.week('2026-10-28')
        self.assertEqual((data['start'], data['end']), ('2026-10-26', '2026-11-01'))
        self.assertEqual([s['date'] for s in data['slots'][::2]],
                         ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'])
        # One session counts once per half day: 00:30 and 11:59 are one morning, 12:00 and 23:59 one afternoon.
        self.assertEqual([data['slots'][i]['chats'] for i in (0, 12, 13)], [1, 1, 1])
        self.assertEqual(data['totals']['chats'], 3)  # excludes the Sunday before and Monday after

    async def test_spring_forward_week_skips_no_slot(self):
        if round(local_day_hours('2026-03-08')) != 23:
            self.skipTest('local zone has no spring-forward on 2026-03-08')
        self.session('a', 'alice', [('user', stamp('2026-03-08', 1, 59)), ('user', stamp('2026-03-08', 3, 30)),
                                    ('user', stamp('2026-03-08', 12, 0)), ('user', stamp('2026-03-09', 0, 0)),
                                    ('user', stamp('2026-03-01', 23, 59))])
        data = await self.week('2026-03-04')
        self.assertEqual((data['start'], data['end']), ('2026-03-02', '2026-03-08'))
        self.assertEqual(len(data['slots']), 14)
        self.assertEqual([data['slots'][i]['chats'] for i in (12, 13)], [1, 1])
        self.assertEqual(data['totals']['chats'], 2)  # excludes Mar 1 and Mar 9

    async def test_run_on_the_dst_sunday_lands_in_its_half_day(self):
        if round(local_day_hours('2026-11-01')) != 25:
            self.skipTest('local zone has no fall-back on 2026-11-01')
        write_json_atomic(tasks_file(), {'a': {'owner_user': 'alice'}})
        write_json_atomic(runs_file(), [{'task_id': 'a', 'started_at': stamp('2026-11-01', 5)},
                                         {'task_id': 'a', 'started_at': stamp('2026-11-01', 18)}])
        data = await self.week('2026-11-01')
        self.assertEqual([data['slots'][i]['agent_runs'] for i in (12, 13)], [1, 1])
        self.assertEqual(data['busiest'], 'Sun')

    async def test_totals_always_match_the_slots(self):
        self.session('a', 'alice', [('user', stamp('2026-10-20', 9)), ('user', stamp('2026-10-20', 15)),
                                    ('user', stamp('2026-10-22', 9))])
        data = await self.week()
        self.assertEqual(data['totals']['chats'], sum(s['chats'] for s in data['slots']))
        self.assertEqual(data['totals']['agent_runs'], sum(s['agent_runs'] for s in data['slots']))

    async def test_completed_notes_are_never_counted(self):
        """Product gap, kept as a pinned fact: the backend never reports completed notes."""
        data = await self.week()
        self.assertIn('notes_done', data['unavailable'])
        self.assertEqual(data['totals']['notes_done'], 0)

    async def test_large_history_aggregates_quickly(self):
        """Benchmark: 1,500 chats with 12 user messages each, plus 3,000 routine runs."""
        import time
        for i in range(1500):
            self.session(f'bulk-{i}', 'alice', [('user', stamp('2026-10-19', 8) + k * 3600 * 7) for k in range(12)])
        write_json_atomic(tasks_file(), {'a': {'owner_user': 'alice'}})
        write_json_atomic(runs_file(), [{'task_id': 'a', 'started_at': stamp('2026-10-19', 9) + k * 120} for k in range(3000)])
        started = time.perf_counter()
        data = await self.week()
        elapsed = time.perf_counter() - started
        print(f'BENCH home_week 1500 chats x 12 messages + 3000 runs: {elapsed * 1000:.0f} ms', flush=True)
        self.assertEqual(len(data['slots']), 14)
        self.assertEqual(data['totals']['chats'], sum(s['chats'] for s in data['slots']))
        self.assertGreater(data['totals']['chats'], 1500)
        self.assertGreater(data['totals']['agent_runs'], 0)
        self.assertLess(elapsed, 3.0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
