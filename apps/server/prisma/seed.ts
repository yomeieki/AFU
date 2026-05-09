import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 开始初始化 Seed 数据...\n')

  // ── 开发测试用户（阶段 3-4 使用，阶段 7 接入微信登录后可移除）────
  await prisma.user.upsert({
    where: { openid: 'dev_openid_001' },
    update: {},
    create: {
      openid: 'dev_openid_001',
      nickname: '测试用户',
      phone: '13800000000',
    },
  })
  console.log('✅ 开发测试用户: id=1, openid=dev_openid_001')

  // ── 管理员 ────────────────────────────────────────────
  const passwordHash = await bcrypt.hash('admin123456', 12)
  await prisma.admin.upsert({
    where: { username: 'admin' },
    update: { passwordHash },
    create: {
      username: 'admin',
      passwordHash,
      name: '店长',
      role: 'admin',
    },
  })
  console.log('✅ 管理员账号: admin / admin123456')

  // ── 商品分类 ──────────────────────────────────────────
  const categoryCount = await prisma.category.count()
  if (categoryCount === 0) {
    await prisma.category.createMany({
      data: [
        { name: '熟食', sortOrder: 1 },
        { name: '礼盒', sortOrder: 2 },
        { name: '预包装食品', sortOrder: 3 },
        { name: '卤味', sortOrder: 4 },
        { name: '素食', sortOrder: 5 },
      ],
    })
    console.log('✅ 创建商品分类：熟食 / 礼盒 / 预包装食品 / 卤味 / 素食')
  } else {
    console.log('ℹ️  商品分类已存在，跳过')
  }

  // ── 示例商品 ──────────────────────────────────────────
  const productCount = await prisma.product.count()
  if (productCount === 0) {
    const [catSS, catLH, catYB] = await Promise.all([
      prisma.category.findFirst({ where: { name: '熟食' } }),
      prisma.category.findFirst({ where: { name: '礼盒' } }),
      prisma.category.findFirst({ where: { name: '预包装食品' } }),
    ])

    if (catSS && catLH && catYB) {
      await prisma.product.createMany({
        data: [
          {
            categoryId: catSS.id,
            name: '招牌猪头肉',
            subtitle: '每日新鲜制作，限量供应',
            price: 2990,
            originalPrice: 3500,
            stock: 100,
            unit: '份',
            weight: '500g',
            shelfLife: '常温3天，冷藏7天',
            storageMethod: '常温存放，开封后冷藏',
            deliveryInfo: '支持顺丰快递，次日达',
            description: '选用优质猪头，秘制卤制，口感鲜嫩，回味无穷。',
            status: 'ON_SHELF',
            deliveryType: 'EXPRESS,LOCAL',
            isRecommended: 1,
            salesCount: 256,
          },
          {
            categoryId: catSS.id,
            name: '秘制酱牛肉',
            subtitle: '传统工艺，入口即化',
            price: 4980,
            originalPrice: 5800,
            stock: 50,
            unit: '份',
            weight: '300g',
            shelfLife: '冷藏7天，冷冻30天',
            storageMethod: '冷藏保存',
            deliveryInfo: '顺丰冷链发货',
            description: '选用优质牛腱子，秘制酱卤，肉质紧实有嚼劲。',
            status: 'ON_SHELF',
            deliveryType: 'EXPRESS',
            isRecommended: 1,
            salesCount: 128,
          },
          {
            categoryId: catSS.id,
            name: '蜜汁叉烧',
            subtitle: '广式叉烧，甜而不腻',
            price: 3580,
            stock: 80,
            unit: '份',
            weight: '400g',
            shelfLife: '冷藏5天',
            storageMethod: '冷藏保存',
            deliveryInfo: '顺丰冷链发货',
            description: '精选五花肉，蜜汁腌制，炭火烤制，色泽红亮。',
            status: 'ON_SHELF',
            deliveryType: 'EXPRESS,LOCAL',
            isRecommended: 0,
            salesCount: 89,
          },
          {
            categoryId: catLH.id,
            name: '年货礼盒（豪华版）',
            subtitle: '精选8款熟食，送礼佳品',
            price: 29800,
            originalPrice: 35000,
            stock: 30,
            unit: '盒',
            weight: '3kg',
            shelfLife: '冷藏7天',
            storageMethod: '冷藏保存',
            deliveryInfo: '顺丰冷链发货，全国包邮',
            description: '精选8款招牌熟食，精美礼盒包装，送长辈、走亲戚的首选。',
            status: 'ON_SHELF',
            deliveryType: 'EXPRESS',
            isRecommended: 1,
            salesCount: 45,
          },
          {
            categoryId: catLH.id,
            name: '家庭实惠礼盒',
            subtitle: '精选4款熟食，家庭首选',
            price: 12800,
            originalPrice: 15000,
            stock: 50,
            unit: '盒',
            weight: '1.5kg',
            shelfLife: '冷藏7天',
            storageMethod: '冷藏保存',
            deliveryInfo: '顺丰冷链发货',
            description: '精选4款热销熟食，实惠装，适合家庭日常享用。',
            status: 'ON_SHELF',
            deliveryType: 'EXPRESS',
            isRecommended: 0,
            salesCount: 67,
          },
          {
            categoryId: catYB.id,
            name: '猪肉脯（原味）',
            subtitle: '酥脆可口，零食首选',
            price: 1280,
            stock: 200,
            unit: '袋',
            weight: '100g',
            shelfLife: '常温90天',
            storageMethod: '阴凉干燥处保存',
            deliveryInfo: '普通快递发货',
            description: '选用优质猪后腿肉，薄片烘烤，口感酥脆。',
            status: 'ON_SHELF',
            deliveryType: 'EXPRESS',
            isRecommended: 0,
            salesCount: 312,
          },
        ],
      })
      console.log('✅ 创建示例商品 6 个')
    }
  } else {
    console.log('ℹ️  商品已存在，跳过')
  }

  console.log('\n🎉 Seed 完成！')
}

main()
  .catch((e) => {
    console.error('❌ Seed 失败:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
