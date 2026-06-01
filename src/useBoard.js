import { useState, useEffect } from 'react'

// S1.3 — card data model + localStorage persistence. The UI (S2.1+) consumes
// this hook; cards have id, title, column, and priority.
const STORAGE_KEY = 'atlas-kanban-board'
export const COLUMNS = ['To Do', 'Doing', 'Done']
export const PRIORITIES = ['high', 'medium', 'low']

function loadBoard() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    /* corrupt/absent — fall through to an empty board */
  }
  return { cards: [] }
}

/** Create a card with the model's fields. */
export function makeCard(title, column = 'To Do', priority = 'medium') {
  const id =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `c-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  return { id, title, column, priority }
}

/** Board state persisted to localStorage across reloads. */
export function useBoard() {
  const [board, setBoard] = useState(loadBoard)
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(board))
    } catch {
      /* storage full / unavailable — keep in-memory state */
    }
  }, [board])
  return [board, setBoard]
}
