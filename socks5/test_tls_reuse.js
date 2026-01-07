const tls = require('tls');

const options = {
  host: '127.0.0.1',
  port: 8002,
  rejectUnauthorized: false,
};

let firstSession = null;
let sessionReceived = false;

const sock1 = tls.connect(options);

sock1.on('session', (session) => {
  // 👈 关键！只有收到 session ticket 后才保存
  firstSession = session;
  sessionReceived = true;
  console.log('🔑 Received session ticket');
});

sock1.on('secureConnect', () => {
  console.log('✅ Conn 1: reused?', sock1.isSessionReused());
  sock1.end();

  // 等待 session 到达（加一点延迟保险）
  const trySecond = () => {
    if (sessionReceived && firstSession) {
      const sock2 = tls.connect({
        ...options,
        session: firstSession,
      }, () => {
        console.log('✅ Conn 2: reused?', sock2.isSessionReused());
        sock2.end();
      });
    } else {
      setTimeout(trySecond, 10); // 最多等 100ms
    }
  };
  setTimeout(trySecond, 5);
});
