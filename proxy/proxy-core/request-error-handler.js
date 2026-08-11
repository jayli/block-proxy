'use strict';

/**
 * Minimal error response handler.
 *
 * Replaces the AnyProxy pug-template-based requestErrorHandler.
 * Returns an HTML string for error pages without requiring pug or template files.
 */

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getCertErrorContent(error, fullUrl) {
  const title = 'The connection is not private.';
  let explain = 'There was an error with the certificate of the site.';

  switch (error.code) {
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY': {
      explain = 'The certificate of the site you are visiting is not issued by a known agency. '
        + 'It usually happens when the cert is a self-signed one.<br>'
        + 'If you know and trust the site, you can configure the proxy to ignore unauthorized SSL.';
      break;
    }
    default: {
      explain = '';
      break;
    }
  }

  return `<!DOCTYPE html>
<html>
<head><title>${escapeHtml(title)}</title></head>
<body>
<h1>${escapeHtml(title)}</h1>
<p>${explain}</p>
<p>Error code: <code>${escapeHtml(error.code || 'UNKNOWN')}</code></p>
${fullUrl ? `<p>URL: ${escapeHtml(fullUrl)}</p>` : ''}
</body>
</html>`;
}

function getDefaultErrorContent(error, fullUrl) {
  const stack = (error.stack || '').split(/\n/).map(line => escapeHtml(line)).join('\n');
  return `<!DOCTYPE html>
<html>
<head><title>Proxy Error</title></head>
<body>
<h1>Proxy Error</h1>
${fullUrl ? `<p>URL: ${escapeHtml(fullUrl)}</p>` : ''}
<pre>${stack}</pre>
</body>
</html>`;
}

module.exports.getErrorContent = function (error, fullUrl) {
  let content = '';
  error = error || {};
  switch (error.code) {
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY': {
      content = getCertErrorContent(error, fullUrl);
      break;
    }
    default: {
      content = getDefaultErrorContent(error, fullUrl);
      break;
    }
  }
  return content;
};
