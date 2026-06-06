import faulthandler
import logging
import logging.handlers
import os
import sys
import threading

DEFAULT_LOG_DIR = os.path.expanduser(
    "~/Library/Application Support/SocksClient/logs"
)

MAX_BYTES = 3 * 1024 * 1024  # 3MB
BACKUP_COUNT = 10

access_logger = logging.getLogger("socksclient.access")
crash_logger = logging.getLogger("socksclient.crash")

_crash_file = None
_initialized = False


def setup_logging(log_dir=None):
    global _crash_file, _initialized
    if _initialized:
        return
    _initialized = True

    if log_dir is None:
        log_dir = DEFAULT_LOG_DIR
    os.makedirs(log_dir, exist_ok=True)

    # Access logger
    access_handler = logging.handlers.RotatingFileHandler(
        os.path.join(log_dir, "access.log"),
        maxBytes=MAX_BYTES,
        backupCount=BACKUP_COUNT,
        encoding="utf-8",
    )
    access_handler.setFormatter(
        logging.Formatter("%(asctime)s | %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
    )
    access_logger.addHandler(access_handler)
    access_logger.setLevel(logging.INFO)

    # Crash logger
    crash_handler = logging.handlers.RotatingFileHandler(
        os.path.join(log_dir, "crash.log"),
        maxBytes=MAX_BYTES,
        backupCount=BACKUP_COUNT,
        encoding="utf-8",
    )
    crash_handler.setFormatter(
        logging.Formatter("%(asctime)s | %(levelname)s | %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
    )
    crash_logger.addHandler(crash_handler)
    crash_logger.setLevel(logging.WARNING)

    # faulthandler — writes C-level tracebacks to a separate fault.log
    fault_log_path = os.path.join(log_dir, "fault.log")
    _crash_file = open(fault_log_path, "a")
    faulthandler.enable(file=_crash_file)

    # sys.excepthook — uncaught Python exceptions
    def _excepthook(exc_type, exc_value, exc_tb):
        crash_logger.critical("Uncaught exception", exc_info=(exc_type, exc_value, exc_tb))
        sys.__excepthook__(exc_type, exc_value, exc_tb)

    sys.excepthook = _excepthook

    # threading.excepthook — uncaught exceptions in threads
    def _thread_excepthook(args):
        if args.exc_type is SystemExit:
            return
        thread_name = args.thread.name if args.thread else "unknown"
        crash_logger.critical(
            f"Thread '{thread_name}' crashed",
            exc_info=(args.exc_type, args.exc_value, args.exc_tb),
        )

    threading.excepthook = _thread_excepthook
