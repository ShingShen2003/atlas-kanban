import { useState, useEffect, useRef, useCallback } from 'react'
import './styles.css'
import { useBoard, makeCard, COLUMNS, PRIORITIES, adjacentColumn } from './useBoard.js'

// S2.1 — add/edit/delete cards.  S2.2 — move cards between columns (card footer
// with ◀/▶, edge-disabled by the card's true column position).  S2.3 — editable
// colored priority badge (a native select that doubles as the pill).
function Card({ card, onRename, onDelete, onMove, onSetPriority, onOpen }) {
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
      // S3.1 — single-click the card body opens the detail modal. Interactive
      // children below stopPropagation so they don't also open it; omitted
      // while editing so clicks in the edit input don't reopen it.
      onClick={
        editing
          ? undefined
          : (e) => {
              // Focus the card so focus restores here when the modal closes
              // (clicking a tabindex element doesn't focus it in some browsers).
              e.currentTarget.focus()
              onOpen(card.id)
            }
      }
      // S3.1 (a11y) — keyboard path: the card is focusable and Enter/Space opens
      // the modal, but only when focus is on the article itself (not an inner
      // control, which handles its own keys). Gives focus somewhere to return to.
      tabIndex={editing ? -1 : 0}
      aria-label={`Card: ${card.title}. Press Enter to open details.`}
      onKeyDown={(e) => {
        if (editing || e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(card.id)
        }
      }}
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
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={() => setEditing(true)}
          >
            {card.title}
          </span>
        )}
        <button
          className="card-delete"
          aria-label={`Delete ${card.title}`}
          onClick={(e) => {
            e.stopPropagation()
            onDelete(card.id)
          }}
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

function Column({ title, cards, onAdd, onRename, onDelete, onMove, onSetPriority, onMoveTo, onOpen }) {
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
            onOpen={onOpen}
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

// S3.1 — read-only card detail modal. Closes on Escape, the × button, or a
// backdrop click (the dialog body stops propagation so inner clicks don't close).
// Accessible-dialog contract: focus moves into the dialog on open, Tab is
// trapped inside it, and focus returns to the trigger on close.
function CardModal({ card, onClose }) {
  const dialogRef = useRef(null)

  useEffect(() => {
    const trigger = document.activeElement
    // Make the background inert: removes it from BOTH the a11y tree and the tab
    // order (so no focusable card lingers in a hidden subtree). Set as the DOM
    // property for reliability across React versions.
    const background = [
      document.querySelector('.topbar'),
      document.querySelector('.board'),
    ].filter(Boolean)
    background.forEach((el) => {
      el.inert = true
    })

    const getFocusable = () =>
      dialogRef.current
        ? Array.from(
            dialogRef.current.querySelectorAll(
              'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
            )
          ).filter((el) => !el.disabled)
        : []

    getFocusable()[0]?.focus() // focus-on-open (the × button)

    function onKey(e) {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key === 'Tab') {
        const els = getFocusable()
        if (els.length === 0) {
          e.preventDefault()
          return
        }
        const first = els[0]
        const last = els[els.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      // Un-inert the background BEFORE restoring focus, or focus() would be
      // blocked by the still-inert subtree.
      background.forEach((el) => {
        el.inert = false
      })
      // focus-restore: return focus to the card that opened the modal
      if (trigger && typeof trigger.focus === 'function') trigger.focus()
    }
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Card details: ${card.title}`}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="modal-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <h2 className="modal-title">{card.title}</h2>
        <dl className="modal-meta">
          <div>
            <dt>Column</dt>
            <dd>{card.column}</dd>
          </div>
          <div>
            <dt>Priority</dt>
            <dd>{card.priority}</dd>
          </div>
          <div>
            <dt>ID</dt>
            <dd>{card.id}</dd>
          </div>
        </dl>
      </div>
    </div>
  )
}

export default function App() {
  const [board, setBoard] = useBoard()
  const [query, setQuery] = useState('') // S2.4 — transient, not persisted
  const [selectedId, setSelectedId] = useState(null) // S3.1 — open card modal

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

  // Resolve from the FULL board (not the filtered view) so an open modal
  // survives a search that would hide its card.
  const selectedCard = board.cards.find((c) => c.id === selectedId) ?? null
  const closeModal = useCallback(() => setSelectedId(null), [])

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
            onOpen={setSelectedId}
          />
        ))}
      </main>
      {selectedCard && <CardModal card={selectedCard} onClose={closeModal} />}
    </div>
  )
}
