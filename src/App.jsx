import { useState } from 'react'
import './styles.css'
import { useBoard, makeCard, COLUMNS, PRIORITIES, adjacentColumn } from './useBoard.js'

// S2.1 — add/edit/delete cards.  S2.2 — move cards between columns (card footer
// with ◀/▶, edge-disabled by the card's true column position).  S2.3 — editable
// colored priority badge (a native select that doubles as the pill).
function Card({ card, onRename, onDelete, onMove, onSetPriority }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(card.title)
  const [dragging, setDragging] = useState(false)
  const idx = COLUMNS.indexOf(card.column)

  function commit() {
    const next = draft.trim()
    if (next && next !== card.title) onRename(card.id, next)
    else setDraft(card.title)
    setEditing(false)
  }

  return (
    <article
      className={`card priority-${card.priority}${dragging ? ' card-dragging' : ''}`}
      // S2.5 — drag source. Disabled while editing so text selection works.
      draggable={!editing}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', card.id)
        e.dataTransfer.effectAllowed = 'move'
        setDragging(true)
      }}
      onDragEnd={() => setDragging(false)}
    >
      <div className="card-main">
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
      </div>
      <div className="card-footer">
        <select
          className={`card-priority priority-${card.priority}`}
          aria-label={`Priority for ${card.title}`}
          value={card.priority}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            e.stopPropagation()
            onSetPriority(card.id, e.target.value)
          }}
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <div className="card-moves">
          <button
            className="card-move"
            aria-label={`Move ${card.title} left`}
            disabled={idx <= 0}
            onClick={(e) => {
              e.stopPropagation()
              onMove(card.id, -1)
            }}
          >
            ◀
          </button>
          <button
            className="card-move"
            aria-label={`Move ${card.title} right`}
            disabled={idx >= COLUMNS.length - 1}
            onClick={(e) => {
              e.stopPropagation()
              onMove(card.id, 1)
            }}
          >
            ▶
          </button>
        </div>
      </div>
    </article>
  )
}

function Column({ title, cards, onAdd, onRename, onDelete, onMove, onSetPriority, onMoveTo }) {
  const [draft, setDraft] = useState('')
  const [dragOver, setDragOver] = useState(false)

  function submit(e) {
    e.preventDefault()
    const t = draft.trim()
    if (!t) return
    onAdd(t, title)
    setDraft('')
  }

  // S2.5 — drop target. preventDefault on dragover is required for drop to fire.
  function handleDrop(e) {
    e.preventDefault()
    setDragOver(false)
    const id = e.dataTransfer.getData('text/plain')
    if (id) onMoveTo(id, title)
  }

  return (
    <section
      className={`column${dragOver ? ' column-dragover' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (!dragOver) setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false)
      }}
      onDrop={handleDrop}
    >
      <h2 className="column-title">
        <span className="column-label">{title}</span>
        <span className="column-count" aria-label={`${cards.length} cards`}>
          {cards.length}
        </span>
      </h2>
      <div className="column-cards" aria-label={`${title} cards`}>
        {cards.map((c) => (
          <Card
            key={c.id}
            card={c}
            onRename={onRename}
            onDelete={onDelete}
            onMove={onMove}
            onSetPriority={onSetPriority}
          />
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
  const [query, setQuery] = useState('') // S2.4 — transient, not persisted

  const addCard = (title, column) =>
    setBoard((b) => ({ ...b, cards: [...b.cards, makeCard(title, column)] }))

  const renameCard = (id, title) =>
    setBoard((b) => ({
      ...b,
      cards: b.cards.map((c) => (c.id === id ? { ...c, title } : c)),
    }))

  const deleteCard = (id) =>
    setBoard((b) => ({ ...b, cards: b.cards.filter((c) => c.id !== id) }))

  const moveCard = (id, dir) =>
    setBoard((b) => ({
      ...b,
      cards: b.cards.map((c) => {
        if (c.id !== id) return c
        const target = adjacentColumn(c.column, dir)
        return target ? { ...c, column: target } : c
      }),
    }))

  const setPriority = (id, priority) =>
    setBoard((b) => ({
      ...b,
      cards: b.cards.map((c) => (c.id === id ? { ...c, priority } : c)),
    }))

  // S2.5 — drop a card onto a column: set its column directly (immutable).
  const moveCardTo = (id, column) =>
    setBoard((b) => ({
      ...b,
      cards: b.cards.map((c) =>
        c.id === id && c.column !== column ? { ...c, column } : c
      ),
    }))

  // S2.4 — filter by title across all columns. Empty query ⇒ the full board
  // (so the default render is identical to S2.1/S2.2/S2.3).
  const q = query.trim().toLowerCase()
  const visibleCards = q
    ? board.cards.filter((c) => c.title.toLowerCase().includes(q))
    : board.cards

  return (
    <div className="app">
      <header className="topbar">
        <h1>Atlas Kanban</h1>
        <div className="search">
          <input
            className="search-input"
            type="search"
            placeholder="Search cards…"
            aria-label="Search cards by title"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('')
            }}
          />
          {query && (
            <button
              className="search-clear"
              aria-label="Clear search"
              onClick={() => setQuery('')}
            >
              ×
            </button>
          )}
        </div>
      </header>
      <main className="board" aria-label="board">
        {COLUMNS.map((title) => (
          <Column
            key={title}
            title={title}
            cards={visibleCards.filter((c) => c.column === title)}
            onAdd={addCard}
            onRename={renameCard}
            onDelete={deleteCard}
            onMove={moveCard}
            onSetPriority={setPriority}
            onMoveTo={moveCardTo}
          />
        ))}
      </main>
    </div>
  )
}
