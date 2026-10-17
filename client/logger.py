import faulthandler
import logging
import logging.handlers
import os
import sys
import threading

DEFAULT_LOG_DIR = os.path.expanduser(
    "~/Library/Application Support/BlockProxyClient/logs"
)

MAX_BYTES = 3 * 1024 * 1024  # 3MB
BACKUP_COUNT = 10

access_logger = logging.getLogger("blockproxyclient.access")
crash_logger = logging.getLogger("blockproxyclient.crash")
diagnostics_logger = logging.getLogger("blockproxyclient.diagnostics")

# 用普通模块 logger 的模块（与上面三个专用 logger 区分开）
MODULE_LOGGERS = (
    "proxy_core",
    "app",
    "tunnel_client",
    "routing",
    "system_proxy",
    "node_connect",
    "autostart",
    "geodata_loader",
)

_crash_file = None
_module_handler = None
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

    # 模块 logger（proxy_core / app / tunnel_client / routing ...）共用
    # 同一个 crash.log handler。这些模块用普通 getLogger(__name__) 而非
    # 专用 logger，以前完全没 handler，端口漂移、recycle 卡死、stop
    # 超时等排障关键告警一条都不落盘。
    # 同一个 handler 对象被多个 logger 持有是安全的（每条记录只经由
    # 实际发出它的那个 logger 到达 handler 一次）；用子集列表而不用
    # 根 logger，避免把第三方库的噪声也写进 crash.log。
    global _module_handler
    if _module_handler is not None:
        # 二次初始化：先摘掉上一轮挂的 handler，避免日志写多份
        for _name in MODULE_LOGGERS:
            _lg = logging.getLogger(_name)
            if _module_handler in _lg.handlers:
                _lg.removeHandler(_module_handler)
        try:
            _module_handler.close()
        except Exception:
            pass
        _module_handler = None
    _module_handler = crash_handler
    for _name in MODULE_LOGGERS:
        _module_logger = logging.getLogger(_name)
        if crash_handler not in _module_logger.handlers:
            _module_logger.addHandler(crash_handler)
        _module_logger.setLevel(logging.INFO)
        _module_logger.propagate = False

    # Diagnostics logger — 周期性的运行指标/异常打点
    diagnostics_handler = logging.handlers.RotatingFileHandler(
        os.path.join(log_dir, "diagnostics.log"),
        maxBytes=MAX_BYTES,
        backupCount=BACKUP_COUNT,
        encoding="utf-8",
    )
    diagnostics_handler.setFormatter(
        logging.Formatter("%(asctime)s | %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
    )
    diagnostics_logger.addHandler(diagnostics_handler)
    diagnostics_logger.setLevel(logging.INFO)

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
            exc_info=(args.exc_type, args.exc_value, args.exc_traceback),
        )

    threading.excepthook = _thread_excepthook
