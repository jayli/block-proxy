// ecosystem.config.js

module.exports = {
  apps: [{
    name: 'block-proxy', // 应用名称
    script: './proxy/start.js', // 启动的脚本文件路径
    instances: '1', // 启动的实例数量，'max' 表示使用所有可用的 CPU 核心
    exec_mode: 'fork', // 执行模式，'cluster' 模式启用 Node.js 的集群功能，实现多核负载均衡
    env: {
      // 环境变量
      NODE_ENV: 'production', // 设置为生产环境
      // 如果你的 express.js 或相关代码依赖其他环境变量，也在这里添加
      // PORT: '8080', // 如果需要指定端口
    },
    // 如果你的 'npm run cp' 脚本是必须的，你需要在 PM2 启动脚本之前执行它
    // 一种方式是将 cp 命令放在 script 中，或者在启动 PM2 之前手动运行 npm run cp
    // 这里假设你已经通过其他方式（比如构建镜像时）确保了 hack 文件已复制
    // 如果需要在 PM2 启动时执行，可以考虑使用 pre_script 或者将复制逻辑写入一个 shell 脚本
    // pre_script: 'npm run cp', // PM2 不直接支持 pre_script，需要其他方式实现
    // 或者将 'npm run cp && node ./server/express.js' 封装成一个 shell 脚本，然后由 PM2 执行
    // 这里直接执行 node 脚本，假设 hack 已经就位
  }]
};
