import { EventEmitter } from 'node:events'

const usageEvents = new EventEmitter()
usageEvents.setMaxListeners(20)

export function notifyUsageRecorded(): void {
  usageEvents.emit('recorded')
}

export function onUsageRecorded(listener: () => void): () => void {
  usageEvents.on('recorded', listener)
  return () => {
    usageEvents.off('recorded', listener)
  }
}
