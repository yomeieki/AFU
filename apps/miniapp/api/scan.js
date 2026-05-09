const { request } = require('../utils/request')

function recordScanLog(scene, source) {
  return request({
    url: '/scan-logs',
    method: 'POST',
    data: { scene: scene, source: source || 'package' },
  }).catch(function() {
    // Scan log is non-critical; swallow errors silently
  })
}

module.exports = { recordScanLog }
