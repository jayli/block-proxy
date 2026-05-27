import os
import sys
import fcntl

LOCK_PATH = os.path.expanduser("~/Library/Application Support/SocksClient/.lock")


def acquire_lock():
    os.makedirs(os.path.dirname(LOCK_PATH), exist_ok=True)
    fp = open(LOCK_PATH, "w")
    try:
        fcntl.flock(fp, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        sys.exit(0)
    fp.write(str(os.getpid()))
    fp.flush()
    return fp


def main():
    lock = acquire_lock()
    from app import SocksClient
    client = SocksClient()
    client.run()


if __name__ == "__main__":
    main()
