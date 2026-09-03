import { config } from '../../config'
import { DeliveryProvider } from './types'
import { kd100Provider } from './kd100'
import { mockProvider } from './mock'

export function getDeliveryProvider(): DeliveryProvider {
  return config.mock.delivery ? mockProvider : kd100Provider
}
