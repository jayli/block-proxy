---
model: default
---

# Pcap Analyse Skill

## Description
分析 pcap/pcapng 网络抓包文件，专注于代理服务器（Socks5 over TLS/HTTP）场景下的连接诊断、性能评估和异常检测。

## Usage
当用户请求分析 pcap 文件，或者提供一个抓包文件并询问网络连接质量、异常或性能问题时使用此 skill。

## Instructions
执行此 skill 时，请遵循以下步骤进行分析。如果用户没有提供 pcap 文件路径，请先询问。

**重要**：你不能直接读取二进制 pcap 文件。你必须编写并执行 Python 脚本（推荐使用 `scapy` 库，如果环境没有则尝试使用 `tshark` 命令行工具）来提取信息。

### 1. 编写分析脚本
编写一个 Python 脚本来解析 pcap 文件，脚本需要提取并计算以下指标：

#### A. 基础信息与抓包点推断
- 统计源 IP 和目的 IP 的出现频率。
- 分析 TCP SYN 包的 TTL (Time To Live) 和 MSS (Max Segment Size)。通常客户端发出的包 TTL 较大（如 64, 128），经过路由后会减少。如果抓到的入站包 TTL 接近默认值（未减少太多），可能是服务端抓包；如果出站包 TTL 是默认值，则是本地发出的。
- 结合端口号（如 8001, 8002）判断流量方向。

#### B. 连接异常分析
- **重传率 (Retransmission Rate)**: 重传包数 / 总包数。
- **复位连接 (RST)**: 统计 RST 包的数量及出现阶段（握手期、数据传输期、结束期）。
- **握手失败**: 有 SYN 但无 SYN/ACK 的比例。
- **TLS 错误**: 检查是否有 TLS Alert 消息。

#### C. 性能分析
- **TCP 握手延迟 (RTT)**: SYN 到 SYN/ACK 的时间差。
- **TLS 握手延迟**: Client Hello 到 Handshake Finished 的时间。
- **数据传输 RTT**: 数据包与对应 ACK 之间的时间差统计（平均值、最大值、最小值、抖动）。

#### D. 连接复用情况
- 统计每个 TCP 流 (Stream) 的持续时间。
- 统计每个流的数据传输量。
- 判断长连接 (Keep-Alive) 的使用情况：是否有长时间空闲但未断开的连接，或者单连接承载多次数据交互。

#### E. 阻塞与拥塞分析
- **Zero Window**: 统计 TCP Zero Window 通告次数（接收端缓冲区满，通知发送端暂停发送）。
- **Window Full**: 统计发送端未收到 ACK 而导致发送窗口耗尽的情况。
- **吞吐量波动**: 检查是否有明显的吞吐量骤降。

#### F. 高并发与吞吐量评估
- **并发连接数**: 统计每一秒内的活跃 TCP 连接数峰值。
- **每秒请求数 (RPS)**: 如果是 HTTP，估算请求速率。
- **峰值带宽**: 计算每秒传输的最大字节数。

### 2. 执行分析与报告
运行脚本获取输出，并生成一份详细的分析报告。报告必须包含以下章节：

1.  **抓包环境推断**:
    - 结论：是客户端抓包还是代理服务器端抓包？
    - 依据：IP 分布、TTL 特征、端口方向。

2.  **连接健康度与异常**:
    - 异常连接比例。
    - 具体的错误类型（重传、RST、超时等）及其对用户体验的潜在影响。

3.  **性能指标**:
    - 平均/P95 延迟数据。
    - 握手耗时分析。

4.  **连接复用分析**:
    - 连接是否被有效复用（Socks5/HTTP Keep-Alive）。
    - 是否存在频繁新建连接导致的开销。

5.  **阻塞情况**:
    - 是否发现 Zero Window 或流控阻塞。
    - 是否有队头阻塞迹象。

6.  **负载能力评估**:
    - 当前并发峰值和吞吐峰值。
    - 基于当前性能指标（如 RTT 抖动、丢包率随流量变化），预估系统在高并发下的抗压能力。

### 3. 示例 Python 代码结构 (供参考)
```python
from scapy.all import *
import collections

# 读取 pcap
packets = rdpcap("path/to/file.pcap")

# 初始化统计变量
# ...

for pkt in packets:
    if TCP in pkt:
        # 统计逻辑
        # ...

# 输出结果
```

**注意**: 如果环境不支持 Python scapy，请尝试使用 `tshark` 命令：
`tshark -r file.pcap -q -z io,stat,1 -z conv,tcp`
以及 `tshark -r file.pcap -Y "tcp.analysis.flags"` 来分析异常。
