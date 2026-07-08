import os
import sys
import fcntl

LOCK_PATH = os.path.expanduser("~/Library/Application Support/BlockProxyClient/.lock")


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


MAX_MAIN_RESTARTS = 3


def main():
    lock = acquire_lock()
    from logger import setup_logging
    setup_logging()

    import time
    from logger import crash_logger

    restarts = 0
    while restarts <= MAX_MAIN_RESTARTS:
        try:
            from app import BlockProxyClient
            client = BlockProxyClient()
            client.run()
            break
        except SystemExit:
            break
        except KeyboardInterrupt:
            break
        except Exception as e:
            restarts += 1
            crash_logger.critical(
                "Main loop crashed (attempt %d/%d)",
                restarts, MAX_MAIN_RESTARTS,
                exc_info=True,
            )
            if restarts > MAX_MAIN_RESTARTS:
                crash_logger.critical("Max restarts exceeded, exiting")
                break
            time.sleep(2)


if __name__ == "__main__":
    main()
