import { Buff, Json } from '@cmdcode/buff-utils'
import { Event, EventTemplate, Filter, Sub } from 'nostr-tools'

import { SignedEvent }    from './event.js'
import { Cipher }         from './cipher.js'
import { isExpired, now } from './util.js'
import { Client }         from '../schema/types.js'

export interface RoomConfig {
  cacheSize      : number
  allowEcho      : boolean
  encryption     : boolean
  expiration     : number
  filter         : Filter
  inactiveLimit ?: number
  kind           : number
  tags           : string[][]
}

const DEFAULTS = {
  cacheSize     : 100,
  allowEcho     : false,
  encryption    : true,
  expiration    : 1000 * 60 * 60 * 24,
  filter        : { since: now() },
  inactiveLimit : 1000 * 60 * 60,
  kind          : 21111,
  tags          : []
}

export class NostrRoom {
  readonly cache  : Array<[ eventName: string, payload: any, envelope : Event ]>
  readonly cipher : Buff
  readonly client : Client
  readonly config : RoomConfig
  readonly events : Record<string, Set<Function>>

  connected : boolean
  _sub      ?: Sub

  constructor (
    client : Client,
    secret : string,
    config : Partial<RoomConfig> = {}
  ) {
    this.cache     = []
    this.cipher    = Buff.str(secret).digest
    this.client    = client
    this.config    = { ...DEFAULTS, ...config }
    this.connected = false
    this.events    = {}

    void this._subscribe()
  }

  get members () : string[] {
    const limit = this.config.inactiveLimit
    const cache = (limit !== undefined)
      ? this.cache.filter(e => isExpired(e[2].created_at, limit))
      : this.cache
    return cache.map(e => e[2].pubkey)
  }

  get id () : Buff {
    return this.cipher.digest
  }

  async _subscribe () {
    const { filter, kind } = this.config
    const { kinds = [] }   = filter

    const subFilter = {
      ...filter,
      kinds : [ ...kinds, kind  ],
      '#h'  : [ this.id.hex ]
    }

    this._sub = await this.client.sub([ subFilter ])

    this._sub.on('event', (event : Event) => {
      void this._eventHandler(event)
    })

    this._sub.on('eose', () => {
      this.connected = true
      this.emit('_connected', this)
    })
  }

  async _eventHandler (event : Event) {
    const { allowEcho } = this.config
    const pubkey = this.client.pubkey
    const signed = new SignedEvent(event)
    const echoed = !allowEcho && signed.isAuthor(pubkey ?? '')

    if (echoed || signed.isExpired || !signed.isValid) {
      console.log(echoed, signed.isExpired, !signed.isValid)
      return
    }

    let content = event.content

    try {
      if (typeof content === 'string' && content.includes('?iv=')) {
        content = await Cipher.decrypt(content, this.cipher)
      }

      // Zod validation should go here.

      const { eventName, payload } = JSON.parse(content)

      // Emit the event to our subscribed functions.
      this.cache.push([ eventName, payload, event ])

      if (this.cache.length > this.config.cacheSize) {
        this.cache.shift()
      }

      this.emit(eventName, payload, event)
    } catch (err) {
      this.emit('_error', err)
    }
  }

  _getFn (eventName : string) {
    /** If key undefined, create a new set for the event,
     *  else return the stored subscriber list.
     * */
    if (typeof this.events[eventName] === 'undefined') {
      this.events[eventName] = new Set()
    }
    return this.events[eventName]
  }

  emit (eventName : string, ...args : any[]) {
    const fns = [ ...this._getFn(eventName) ]
    for (const fn of fns) {
      fn.apply(this, args)
    }
    const all = [ ...this._getFn('*') ]
    for (const fn of all) {
      args = [ eventName, ...args ]
      fn.apply(this, args)
    }
  }

  async pub (
    eventName : string,
    payload   : Json,
    template  : Partial<EventTemplate> = {}
  ) : Promise<Event | undefined> {
    /** Emit a series of arguments for the event, and
     *  present them to each subscriber in the list.
     * */

    if (!this.connected) {
      throw new Error('Not connected to room!')
    }
    const { encryption, expiration, kind } = this.config
    const { tags: conf_tags }  = this.config
    const { tags: temp_tags = [], ...rest } = template

    try {
      let content = JSON.stringify({ eventName, payload })

      if (encryption) {
        content = await Cipher.encrypt(content, this.cipher)
      }

      const tags = [
        ...conf_tags,
        ...temp_tags,
        [ 'h', this.id.hex ],
        [ 'expiration', String(now() + expiration) ]
      ]

      const envelope = { kind, ...rest, tags  }
      const draft    = { ...envelope, content }

      return await this.client.publish(draft)
    } catch (err) {
      console.error(err)
      this.emit('_error', err)
      return undefined
    }
  }

  on (eventName : string, fn : Function) : void {
    /** Subscribe function to run on a given event. */
    this._getFn(eventName).add(fn)
  }

  once (eventName : string, fn : Function) {
    /** Subscribe function to run once, using
     *  a callback to cancel the subscription.
     * */

    const onceFn = (...args : any[]) => {
      this.remove(eventName, onceFn)
      fn.apply(this, args)
    }
    this.on(eventName, onceFn)
  }

  within (eventName : string, fn : Function, timeout : number) {
    /** Subscribe function to run within a given,
     *  amount of time, then cancel the subscription.
     * */
    const withinFn = (...args : any[]) => fn.apply(this, args)
    setTimeout(() => { this.remove(eventName, withinFn) }, timeout)

    this.on(eventName, withinFn)
  }

  remove (eventName : string, fn : Function) {
    /** Remove function from an event's subscribtion list. */
    this._getFn(eventName).delete(fn)
  }

  prune (eventName : string) {
    this.events[eventName] = new Set()
  }

  leave () {
    this._sub?.unsub()
    this.connected = false
    this.emit('_leave', this.id)
  }
}
