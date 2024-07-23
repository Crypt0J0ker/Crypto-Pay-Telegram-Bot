const TelegramBot = require('node-telegram-bot-api')
const mongoose = require('mongoose')
const axios = require('axios')
const schedule = require('node-schedule')

require('dotenv').config()

console.log('Crypto Pay Telegram Bot is running...')

const token = process.env.TELEGRAM_BOT_TOKEN
const bot = new TelegramBot(token, { polling: true })

const WALLET_ADDRESS = process.env.WALLET_ADDRESS
const MONTHLY_PRICE = process.env.MONTHLY_PRICE
const YEARLY_PRICE = process.env.YEARLY_PRICE
const CHAIN_ID = process.env.CHAIN_ID

mongoose.connect(process.env.MONGO_URI)

const subscriptionSchema = new mongoose.Schema({
  userId: Number,
  endDate: Date,
})

const transactionSchema = new mongoose.Schema({
  transactionHash: String,
})

const Subscription = mongoose.model('Subscription', subscriptionSchema)
const Transaction = mongoose.model('Transaction', transactionSchema)

bot.onText(/\/start/, async msg => {
  const userId = msg.from.id

  const subscription = await Subscription.findOne({ userId: userId })
  if (subscription) {
    const now = new Date()
    if (subscription.endDate > now) {
      bot.sendMessage(userId, 'Ваша подписка активна.')
    } else {
      const message = `*Ваша подписка истекла.*

Для продления переведите необходимую сумму на адрес \`${WALLET_ADDRESS}\` в сети Sepolia:

- \`${MONTHLY_PRICE} ETH\` для подписки на месяц
- \`${YEARLY_PRICE} ETH\` для подписки на год

Затем отправьте хэш транзакции в этот чат.`

      bot.sendMessage(userId, message, { parse_mode: 'Markdown' })
    }
  } else {
    const message = `*У вас нет активной подписки.*

Для активации подписки переведите необходимую сумму на адрес \`${WALLET_ADDRESS}\` в сети Sepolia:

- \`${MONTHLY_PRICE} ETH\` для подписки на месяц
- \`${YEARLY_PRICE} ETH\` для подписки на год

Затем отправьте хэш транзакции в этот чат.`

    bot.sendMessage(userId, message, { parse_mode: 'Markdown' })
  }
})

const checkSubscriptions = async () => {
  const now = new Date()
  const expiredSubscriptions = await Subscription.find({
    endDate: { $lt: now },
  })

  expiredSubscriptions.forEach(subscription => {
    const message = `*Ваша подписка истекла.*

Для продления переведите необходимую сумму на адрес \`${WALLET_ADDRESS}\` в сети Sepolia:

- \`${MONTHLY_PRICE} ETH\` для подписки на месяц
- \`${YEARLY_PRICE} ETH\` для подписки на год

Затем отправьте хэш транзакции в этот чат.`

    bot.sendMessage(subscription.userId, message, { parse_mode: 'Markdown' })
  })

  const expiringSubscriptions = await Subscription.find({
    endDate: {
      $gte: now,
      $lte: new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000),
    },
  })

  expiringSubscriptions.forEach(subscription => {
    const daysLeft = Math.ceil(
      (subscription.endDate - now) / (24 * 60 * 60 * 1000)
    )
    let message = ''

    if (daysLeft === 3) {
      message = `*Ваша подписка истекает через 3 дня.*

Для продления переведите необходимую сумму на адрес \`${WALLET_ADDRESS}\` в сети Sepolia:

- \`${MONTHLY_PRICE} ETH\` для подписки на месяц
- \`${YEARLY_PRICE} ETH\` для подписки на год

Затем отправьте хэш транзакции в этот чат.`
    } else if (daysLeft === 2) {
      message = `*Ваша подписка истекает через 2 дня.*

Для продления переведите необходимую сумму на адрес \`${WALLET_ADDRESS}\` в сети Sepolia:

- \`${MONTHLY_PRICE} ETH\` для подписки на месяц
- \`${YEARLY_PRICE} ETH\` для подписки на год

Затем отправьте хэш транзакции в этот чат.`
    } else if (daysLeft === 1) {
      message = `*Ваша подписка истекает завтра.*

Для продления переведите необходимую сумму на адрес \`${WALLET_ADDRESS}\` в сети Sepolia:

- \`${MONTHLY_PRICE} ETH\` для подписки на месяц
- \`${YEARLY_PRICE} ETH\` для подписки на год

Затем отправьте хэш транзакции в этот чат.`
    }

    if (message) {
      bot.sendMessage(subscription.userId, message, { parse_mode: 'Markdown' })
    }
  })
}

schedule.scheduleJob('0 0 * * *', checkSubscriptions)

bot.on('message', async msg => {
  if (msg.text === '/start') return

  const userId = msg.from.id
  const transactionHash = msg.text.trim()

  if (!transactionHash.startsWith('0x')) {
    bot.sendMessage(
      userId,
      'Пожалуйста, отправьте корректный хэш транзакции, начинающийся с "0x".'
    )
    return
  }

  try {
    const existingTransaction = await Transaction.findOne({ transactionHash })
    if (existingTransaction) {
      bot.sendMessage(userId, 'Эта транзакция уже была использована.')
      return
    }

    const response = await axios.get('https://api-sepolia.etherscan.io/api', {
      params: {
        module: 'proxy',
        action: 'eth_getTransactionByHash',
        txhash: transactionHash,
        apikey: process.env.ETHERSCAN_API_KEY,
      },
    })

    const transaction = response.data.result
    if (!transaction) {
      bot.sendMessage(userId, 'Транзакция не найдена.')
      return
    }

    const toAddress = transaction.to ? transaction.to.toLowerCase() : null
    const value = transaction.value
      ? parseInt(transaction.value, 16) / Math.pow(10, 18)
      : 0
    const chainId = transaction.chainId

    if (chainId !== CHAIN_ID) {
      bot.sendMessage(userId, 'Неверная сеть.')
      return
    }

    if (toAddress === WALLET_ADDRESS.toLowerCase()) {
      let newEndDate
      const subscription = await Subscription.findOne({ userId: userId })
      if (subscription && subscription.endDate > new Date()) {
        newEndDate = new Date(subscription.endDate)
      } else {
        newEndDate = new Date()
      }

      if (value >= YEARLY_PRICE) {
        newEndDate.setFullYear(newEndDate.getFullYear() + 1)
        bot.sendMessage(userId, 'Подписка успешно продлена на год!')
      } else if (value >= MONTHLY_PRICE) {
        newEndDate.setMonth(newEndDate.getMonth() + 1)
        bot.sendMessage(userId, 'Подписка успешно продлена на месяц!')
      } else {
        bot.sendMessage(userId, 'Недостаточная сумма для продления подписки.')
        return
      }

      await Subscription.findOneAndUpdate(
        { userId: userId },
        { userId: userId, endDate: newEndDate },
        { upsert: true, new: true }
      )

      const newTransaction = new Transaction({ transactionHash })
      await newTransaction.save()
    } else {
      bot.sendMessage(userId, 'Неверный адрес получателя.')
    }
  } catch (error) {
    console.error('Error fetching transaction:', error)
    bot.sendMessage(userId, 'Произошла ошибка при проверке транзакции.')
  }
})
