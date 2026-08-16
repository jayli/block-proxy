"""健康检查决策纯函数。

与 PyObjC 无关，便于单测；app.py 的健康检查循环调用。
背景：健康检查每 3s 检查本地代理线程，发现死亡会 sleep(2) 后重启。
若在“用户点关闭代理”或全量重连的瞬间 tick，会误判线程死亡，把
刚关闭的代理重新拉起（global 模式下还会重新开启系统代理）。
这些函数把跳过/重启条件集中为纯逻辑并加回归测试。
"""


def health_check_skip_reason(connected, quitting, reconnecting,
                             connecting, disconnecting, recycling):
    """返回跳过本轮健康检查的原因；None 表示不跳过。"""
    if not connected:
        return "not_connected"
    if quitting:
        return "quitting"
    if reconnecting:
        return "reconnecting"
    if connecting:
        return "connecting"
    if disconnecting:
        return "disconnecting"
    if recycling:
        return "recycling"
    return None


def health_check_restart_allowed(connected, disconnecting, connecting):
    """sleep(2) 后重启前复核：关停/重连可能已在等待期间完成。"""
    return bool(connected) and not disconnecting and not connecting
