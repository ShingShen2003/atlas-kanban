import { useState } from 'react'
import './styles.css'
import { useBoard, makeCard, COLUMNS } from './useBoard.js'

// S2.1 — add / edit / delete cards, persisted via the S1.3 board hook.
function Card({ card, onRename, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(card.title)

  function commit() {
    const next = draft.trim()
    if (next && next !== card.title) onRename(card.id, next)
    else setDraft(card.title)
    setEditing(false)
  }

  return (
    <article className={`card priority-${card.priority}`}>
      {editing ? (
        <input
          className="card-edit"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setDraft(card.title)
              setEditing(false)
            }
          }}
        />
      ) : (
        <span
          className="card-title"
          title="Double-click to edit"
          onDoubleClick={() => setEditing(true)}
        >
          {card.title}
        </span>
      )}
      <button
        className="card-delete"
        aria-label={`Delete ${card.title}`}
        onClick={() => onDelete(card.id)}
      >
        ×
      </button>
    </article>
  )
}

function Column({ title, cards, onAdd, onRename, onDelete }) {
  const [draft, setDraft] = useState('')

  function submit(e) {
    e.preventDefault()
    const t = draft.trim()
    if (!t) return
    onAdd(t, title)
    setDraft('')
  }

  return (
    <section className="column">
      <h2 className="column-title">{title}</h2>
      <div className="column-cards" aria-label={`${title} cards`}>
        {cards.map((c) => (
          <Card key={c.id} card={c} onRename={onRename} onDelete={onDelete} />
        ))}
      </div>
      <form className="add-card" onSubmit={submit}>
        <input
          className="add-card-input"
          placeholder="Add a card…"
          aria-label={`Add a card to ${title}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="add-card-btn" type="submit" aria-label={`Add to ${title}`}>
          +
        </button>
      </form>
    </section>
  )
}

export default function App() {
  const [board, setBoard] = useBoard()

  const addCard = (title, column) =>
    setBoard((b) => ({ ...b, cards: [...b.cards, makeCard(title, column)] }))

  const renameCard = (id, title) =>
    setBoard((b) => ({
      ...b,
      cards: b.cards.map((c) => (c.id === id ? { ...c, title } : c)),
    }))

  const deleteCard = (id) =>
    setBoard((b) => ({ ...b, cards: b.cards.filter((c) => c.id !== id) }))

  return (
    <div className="app">
      <header className="topbar">
        <h1>Atlas Kanban</h1>
      </header>
      <main className="board" aria-label="board">
        {COLUMNS.map((title) => (
          <Column
            key={title}
            title={title}
            cards={board.cards.filter((c) => c.column === title)}
            onAdd={addCard}
            onRename={renameCard}
            onDelete={deleteCard}
          />
        ))}
      </main>
    </div>
  )
}
