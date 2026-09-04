Component({
  data: {
    visible: false,
  },

  lifetimes: {
    // 页面/组件卸载时若弹层仍可见，先 disagree 掉挂起的 resolve，避免调用方 Promise 永远悬着。
    detached() {
      var app = getApp()
      var resolve = app.globalData.privacyResolve
      if (!resolve) return
      app.globalData.privacyResolve = null
      resolve({ event: 'disagree' })
    },
  },

  methods: {
    show() {
      this.setData({ visible: true })
    },

    resolvePrivacy(payload) {
      var app = getApp()
      var resolve = app.globalData.privacyResolve
      this.setData({ visible: false })
      app.globalData.privacyResolve = null
      if (resolve) resolve(payload)
    },

    onAgree() {
      this.resolvePrivacy({ event: 'agree', buttonId: 'privacy-agree-btn' })
    },

    onDisagree() {
      this.resolvePrivacy({ event: 'disagree' })
    },

    openPrivacyContract() {
      wx.openPrivacyContract({
        fail() {
          wx.navigateTo({ url: '/pages/legal/index?type=privacy' })
        },
      })
    },

    // 阻止遮罩触摸滚动穿透；必须通过按钮明确作出授权选择。
    noop() {},
  },
})
