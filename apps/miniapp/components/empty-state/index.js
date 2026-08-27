Component({
  properties: {
    // 插画类型：cart / order / address / product / generic
    type: {
      type: String,
      value: 'generic',
    },
    text: {
      type: String,
      value: '暂无数据',
    },
    // 传入则显示操作按钮
    actionText: {
      type: String,
      value: '',
    },
  },
  methods: {
    onAction() {
      this.triggerEvent('action')
    },
  },
})
