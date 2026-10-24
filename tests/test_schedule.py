from flock_of_pain.schedule import Schedule, business_hours

D = 1440


def test_is_on_window_edges():
    s = business_hours(9, 17)
    assert s.is_on(9 * 60)
    assert not s.is_on(8 * 60 + 59)
    assert not s.is_on(17 * 60)
    assert not s.is_on(5 * D + 10 * 60)


def test_next_on():
    s = business_hours(9, 17)
    assert s.next_on(10 * 60) == 10 * 60
    assert s.next_on(17 * 60) == D + 9 * 60
    assert s.next_on(4 * D + 18 * 60) == 7 * D + 9 * 60


def test_next_on_none_when_empty():
    assert Schedule({}).next_on(0) is None


def test_on_minutes_week():
    assert business_hours(9, 17).on_minutes(0, 7 * D) == 5 * 8 * 60


def test_absence():
    s = Schedule(business_hours(9, 17).weekday_hours, [(D + 9 * 60, D + 17 * 60)])
    assert not s.is_on(D + 10 * 60)
    assert s.on_minutes(0, 7 * D) == 4 * 8 * 60
    assert s.next_on(D + 10 * 60) == 2 * D + 9 * 60


def test_absence_mid_window():
    s = Schedule({0: (9, 17)}, [(12 * 60, 13 * 60)])
    assert s.next_on(12 * 60 + 30) == 13 * 60
    assert s.next_off(9 * 60) == 12 * 60
    assert s.on_minutes(0, D) == 7 * 60


def test_next_off():
    assert business_hours(9, 17).next_off(9 * 60) == 17 * 60


def test_on_minutes_multi_week_partial():
    s = business_hours(9, 17)
    assert s.on_minutes(0, 14 * D) == 10 * 8 * 60


def test_absence_starts_before_window_ends_inside():
    s = Schedule({0: (9, 17)}, [(8 * 60, 10 * 60)])
    assert s.on_minutes(0, D) == 7 * 60
    assert not s.is_on(8 * 60)
    assert not s.is_on(9 * 60 + 30)
    assert s.is_on(10 * 60)
    assert s.next_on(9 * 60) == 10 * 60


def test_absence_starts_inside_window_ends_after():
    s = Schedule({0: (9, 17)}, [(15 * 60, 20 * 60)])
    assert s.on_minutes(0, D) == 6 * 60
    assert s.is_on(15 * 60 - 1)
    assert not s.is_on(15 * 60)
    assert s.next_off(9 * 60) == 15 * 60


def test_absence_spanning_several_days():
    s = Schedule(business_hours(9, 17).weekday_hours, [(D + 12 * 60, 3 * D + 12 * 60)])
    # Mon 8h, Tue 9-12 (3h), Wed none, Thu 12-17 (5h), Fri 8h
    assert s.on_minutes(0, 7 * D) == (8 + 3 + 5 + 8) * 60
    assert not s.is_on(2 * D + 10 * 60)
    assert s.next_on(D + 13 * 60) == 3 * D + 12 * 60


def test_on_minutes_partial_range():
    s = business_hours(9, 17)
    assert s.on_minutes(12 * 60, D) == 5 * 60
    assert s.on_minutes(0, 12 * 60) == 3 * 60
    assert s.on_minutes(10 * 60, 11 * 60) == 60
    assert s.on_minutes(12 * 60, 12 * 60) == 0


def test_absence_half_open_edges():
    a, b = D + 10 * 60, D + 12 * 60
    s = Schedule({1: (9, 17)}, [(a, b)])
    assert s.is_on(a - 1)
    assert not s.is_on(a)
    assert not s.is_on(b - 1)
    assert s.is_on(b)
