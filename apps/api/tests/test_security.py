from app.security import digest, hash_password, verify_password


def test_password_round_trip():
    hashed = hash_password("correct horse battery staple")
    assert verify_password(hashed, "correct horse battery staple")
    assert not verify_password(hashed, "wrong")


def test_digest_is_stable():
    assert digest("token") == digest("token")
    assert digest("token") != digest("other")

