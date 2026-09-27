// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ConfirmDialog, ConfirmModels } from './ConfirmDialog'

Object.defineProperty(Element.prototype, 'animate', { value: undefined, configurable: true })

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ConfirmDialog', () => {
  it('renders title, message and buttons when open', async () => {
    const onClose = vi.fn()
    const onConfirm = vi.fn()
    render(
      <ConfirmDialog
        open={true}
        onClose={onClose}
        onConfirm={onConfirm}
        title="Remove file?"
        message="This will remove it from the list."
        details="File: test.zip"
        confirmLabel="Remove"
        variant="danger"
        icon="trash"
      />,
    )
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Remove file?')).toBeTruthy()
    expect(screen.getByText('This will remove it from the list.')).toBeTruthy()
    expect(screen.getByText('File: test.zip')).toBeTruthy()
    expect(screen.getByText('Remove')).toBeTruthy()
    expect(screen.getByText('Cancel')).toBeTruthy()
  })

  it('calls onConfirm then onClose when confirm is clicked', () => {
    const onClose = vi.fn()
    const onConfirm = vi.fn()
    render(
      <ConfirmDialog
        open={true}
        onClose={onClose}
        onConfirm={onConfirm}
        title="Clear completed?"
        message="Remove all completed downloads."
        confirmLabel="Clear"
        variant="danger"
        icon="clear"
      />,
    )
    fireEvent.click(screen.getByText('Clear'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when cancel is clicked or backdrop is clicked', () => {
    const onClose = vi.fn()
    const onConfirm = vi.fn()
    const { container } = render(
      <ConfirmDialog open={true} onClose={onClose} onConfirm={onConfirm} title="Reset?" message="Reset settings?" />,
    )
    fireEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalledTimes(1)
    // backdrop is the first div inside the motion.div with bg-black/50
    const backdrop = container.querySelector('.bg-black\\/50') as HTMLElement
    if (backdrop) {
      fireEvent.click(backdrop)
      expect(onClose).toHaveBeenCalledTimes(2)
    }
  })

  it('has preset models for important actions', () => {
    const remove = ConfirmModels.removeDownload('myfile.zip', 'downloading')
    expect(remove.title).toContain('myfile.zip')
    expect(remove.variant).toBe('danger')
    expect(remove.icon).toBe('trash')

    const cancel = ConfirmModels.cancelDownload('myfile.zip', 1024 * 1024, 10 * 1024 * 1024)
    expect(cancel.variant).toBe('warning')

    const clear = ConfirmModels.clearCompleted(3)
    expect(clear.title).toContain('3')
    expect(clear.variant).toBe('danger')

    const reset = ConfirmModels.resetSettings()
    expect(reset.variant).toBe('warning')

    const folder = ConfirmModels.forgetFolder('flux-downloads')
    expect(folder.icon).toBe('folder')
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    const onConfirm = vi.fn()
    render(<ConfirmDialog open={true} onClose={onClose} onConfirm={onConfirm} title="Test" />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
