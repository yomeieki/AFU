const { adminUrl } = require('../../config/index')

// 内嵌网页后台：/m?code=<一次性码>[&to=<页面>]，网页端换 token 后自动进入
Page({
  data: { src: '' },

  onLoad(options) {
    if (!options.code) {
      wx.showToast({ title: '缺少登录凭证', icon: 'none' })
      setTimeout(function() { wx.navigateBack() }, 1200)
      return
    }
    var src = adminUrl + '/m?code=' + encodeURIComponent(options.code)
    if (options.target) src += '&to=' + encodeURIComponent(options.target)
    this.setData({ src: src })
  },
})
