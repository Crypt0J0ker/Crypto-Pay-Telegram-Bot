const TelegramBot = require('node-telegram-bot-api')
const { MongoClient, ServerApiVersion } = require('mongodb')
const axios = require('axios')
const schedule = require('node-schedule')

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config()
}

const token = process.env.TELEGRAM_BOT_TOKEN
const bot = new TelegramBot(token, { polling: true })

const WALLET_ADDRESS = process.env.WALLET_ADDRESS
const MONTHLY_PRICE = process.env.MONTHLY_PRICE
const YEARLY_PRICE = process.env.YEARLY_PRICE
const CHAIN_ID = process.env.CHAIN_ID

const uri = process.env.MONGO_URI
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
})

async function connectToDatabase() {
  try {
    // Connect the client to the server
    await client.connect()
    // Send a ping to confirm a successful connection
    await client.db('admin').command({ ping: 1 })
    console.log(
      'Pinged your deployment. You successfully connected to MongoDB!'
    )

    // Return database instance
    return client.db('subscriptions')
  } catch (error) {
    console.error('MongoDB connection error:', error)
    throw error
  }
}

async function startBot() {
  const db = await connectToDatabase()
  if (!db) {
    console.error('Failed to connect to the database.')
    return
  }

  const subscriptions = db.collection('subscriptions')
  const transactions = db.collection('transactions')

  bot.onText(/\/start/, async msg => {
    const userId = msg.from.id
    console.log(`Received /start from user ${userId}`)

    const subscription = await subscriptions.findOne({ userId: userId })
    const now = new Date()
    if (subscription) {
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
    console.log(`Checking subscriptions at ${now}`)
    const expiredSubscriptions = await subscriptions
      .find({
        endDate: { $lt: now },
      })
      .toArray()

    expiredSubscriptions.forEach(subscription => {
      const message = `*Ваша подписка истекла.*

Для продления переведите необходимую сумму на адрес \`${WALLET_ADDRESS}\` в сети Sepolia:

- \`${MONTHLY_PRICE} ETH\` для подписки на месяц
- \`${YEARLY_PRICE} ETH\` для подписки на год

Затем отправьте хэш транзакции в этот чат.`
      bot.sendMessage(subscription.userId, message, { parse_mode: 'Markdown' })
    })

    const expiringSubscriptions = await subscriptions
      .find({
        endDate: {
          $gte: now,
          $lte: new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000),
        },
      })
      .toArray()

    expiringSubscriptions.forEach(subscription => {
      const daysLeft = Math.ceil(
        (subscription.endDate - now) / (24 * 60 * 60 * 1000)
      )
      let message = ''

      if (daysLeft === 3) {
        message = `*Ваша подписка истекает через 3 дня.*

Для продления переведите необходимую сумму на адрес \`${WALLET_ADDRESS}\` в сети Sepolia:

- \`${MONTHЛY_PRICE} ETH\` для подписки на месяц
- \`${YEARLY_PRICE} ETH\` для подписки на год

Затем отправьте хэш транзакции в этот чат.`
      } else if (daysLeft === 2) {
        message = `*Ваша подписка истекает через 2 дня.*

Для продления переведите необходимую сумму на адрес \`${WALLET_ADDRESS}\` в сети Sepolia:

- \`${MONTHЛY_PRICE} ETH\` для подписки на месяц
- \`${YEARLY_PRICE} ETH\` для подписки на год

Затем отправьте хэш транзакции в этот чат.`
      } else if (daysLeft === 1) {
        message = `*Ваша подписка истекает завтра.*

Для продления переведите необходимую сумму на адрес \`${WALLET_ADDRESS}\` в сети Sepolia:

- \`${MONTHЛY_PRICE} ETH\` для подписки на месяц
- \`${YEARLY_PRICE} ETH\` для подписки на год

Затем отправьте хэш транзакции в этот чат.`
      }

      if (message) {
        bot.sendMessage(subscription.userId, message, {
          parse_mode: 'Markdown',
        })
      }
    })
  }

  schedule.scheduleJob('* * * * *', checkSubscriptions)

  bot.on('message', async msg => {
    if (msg.text === '/start') return

    const userId = msg.from.id
    const transactionHash = msg.text.trim()
    console.log(
      `Received transaction hash from user ${userId}: ${transactionHash}`
    )

    if (!transactionHash.startsWith('0x')) {
      bot.sendMessage(
        userId,
        'Пожалуйста, отправьте корректный хэш транзакции, начинающийся с "0x".'
      )
      return
    }

    try {
      const existingTransaction = await transactions.findOne({
        transactionHash,
      })
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

      console.log(
        `Transaction details: toAddress=${toAddress}, value=${value}, chainId=${chainId}`
      )

      if (chainId !== CHAIN_ID) {
        bot.sendMessage(userId, 'Неверная сеть.')
        return
      }

      if (toAddress === WALLET_ADDRESS.toLowerCase()) {
        let newEndDate
        const subscription = await subscriptions.findOne({ userId: userId })
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

        await subscriptions.updateOne(
          { userId: userId },
          { $set: { userId: userId, endDate: newEndDate } },
          { upsert: true }
        )

        await transactions.insertOne({ transactionHash })
      } else {
        bot.sendMessage(userId, 'Неверный адрес получателя.')
      }
    } catch (error) {
      console.error('Error fetching transaction:', error)
      bot.sendMessage(userId, 'Произошла ошибка при проверке транзакции.')
    }
  })
}

startBot().catch(console.dir)

module.exports = (req, res) => {
  res.status(200).send('Bot is running!')
}
