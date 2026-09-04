Component({
  data: {
    visible: false,
  },

  methods: {
    show() {
      this.setData({ visible: true })
    },

    resolvePrivacy(event) {
      var app = getApp()
      var resolve = app.globalData.privacyResolve
      this.setData({ visible: false })
      app.globalData.privacyResolve = null
      if (resolve) resolve({ event: event })
    },

    onAgree() {
      this.resolvePrivacy('agree')
    },

    onDisagree() {
      this.resolvePrivacy('disagree')
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
