import { describe, expect, it } from 'vitest'
import { sortWords, filterWordsByQuery } from './wordUtils'

describe('wordUtils', () => {
  it('sorts words by alphabet and then by created order', () => {
    const words = [
      { id: 2, word: 'zebra', createdAt: 2 },
      { id: 1, word: 'Apple', createdAt: 1 },
      { id: 3, word: 'apple', createdAt: 3 },
    ]

    expect(sortWords(words, 'az')).toEqual([
      { id: 1, word: 'Apple', createdAt: 1 },
      { id: 3, word: 'apple', createdAt: 3 },
      { id: 2, word: 'zebra', createdAt: 2 },
    ])
  })

  it('filters words by keyword in either the word or its translation', () => {
    const words = [
      { word: 'apple', translation: '苹果' },
      { word: 'banana', translation: '香蕉' },
      { word: 'car', translation: '汽车' },
    ]

    expect(filterWordsByQuery(words, '苹')).toEqual([
      { word: 'apple', translation: '苹果' },
    ])
  })
})
