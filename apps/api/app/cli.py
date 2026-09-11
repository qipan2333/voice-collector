import argparse

from sqlalchemy import select

from .db import SessionLocal
from .models import Study


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["list-studies"])
    args = parser.parse_args()
    if args.command == "list-studies":
        db = SessionLocal()
        try:
            for study in db.scalars(select(Study).order_by(Study.created_at)).all():
                print(f"{study.id}\t{study.status}\t{study.title}")
        finally:
            db.close()


if __name__ == "__main__":
    main()

