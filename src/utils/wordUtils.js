export function sortWords(words, mode = 'az') {
  const normalized = [...words]

  return normalized.sort((a, b) => {
    const left = String(a.word || '').trim().toLowerCase()
    const right = String(b.word || '').trim().toLowerCase()

    if (mode === 'za') {
      return right.localeCompare(left)
    }

    if (mode === 'recent') {
      return (b.createdAt || 0) - (a.createdAt || 0)
    }

    return left.localeCompare(right)
  })
}

export function filterWordsByQuery(words, query = '') {
  const normalized = query.trim().toLowerCase()

  if (!normalized) {
    return words
  }

  return words.filter((entry) => {
    const word = String(entry.word || '').toLowerCase()
    const translation = String(entry.translation || '').toLowerCase()
    const note = String(entry.note || '').toLowerCase()

    return word.includes(normalized) || translation.includes(normalized) || note.includes(normalized)
  })
}
