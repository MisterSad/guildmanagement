import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appHtml } from './helpers/app-html.js';
import fs from 'fs';
import path from 'path';
import { createDialog, openDialog, closeDialog } from '../src/components/ui/Dialog';

describe('WCAG 2.2 AA Accessibility & Focus Management (TICKET-11 / A11Y-01)', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="app">
        <button id="trigger-btn">Open Dialog</button>
        <button id="other-btn">Other Page Content</button>
      </div>
    `;
  });

  afterEach(() => {
    document.querySelectorAll('.gm-ui-dialog-backdrop').forEach((d) => closeDialog(d));
    document.body.innerHTML = '';
  });

  describe('WAI-ARIA Semantic Roles & Attributes (createDialog)', () => {
    it('applies role="dialog" by default for non-destructive dialogs', () => {
      const dialog = createDialog({
        title: 'Edit Profile',
        body: '<p>Edit your profile details.</p>',
        confirmLabel: 'Save',
        cancelLabel: 'Cancel',
      });

      const card = dialog.querySelector('.gm-ui-dialog-wrap');
      expect(card).not.toBeNull();
      expect(card.getAttribute('role')).toBe('dialog');
      expect(card.getAttribute('aria-modal')).toBe('true');
    });

    it('applies role="alertdialog" when tone is danger (destructive/warning action)', () => {
      const dialog = createDialog({
        title: 'Delete Guild',
        tone: 'danger',
        body: '<p>This action cannot be undone.</p>',
        confirmLabel: 'Delete',
        cancelLabel: 'Cancel',
      });

      const card = dialog.querySelector('.gm-ui-dialog-wrap');
      expect(card).not.toBeNull();
      expect(card.getAttribute('role')).toBe('alertdialog');
      expect(card.getAttribute('aria-modal')).toBe('true');
    });

    it('links aria-labelledby to the title element id', () => {
      const dialog = createDialog({
        id: 'test-dlg',
        title: 'Modal Title',
        body: 'Content',
      });

      const card = dialog.querySelector('.gm-ui-dialog-wrap');
      const titleId = card.getAttribute('aria-labelledby');
      const titleEl = card.querySelector('#' + titleId);

      expect(titleEl).not.toBeNull();
      expect(titleEl.textContent).toBe('Modal Title');
    });

    it('links aria-describedby to subtitle id or explicit describedBy target', () => {
      const dialogWithSubtitle = createDialog({
        id: 'sub-dlg',
        title: 'With Subtitle',
        subtitle: 'Secondary hint text',
        body: 'Content',
      });

      const card = dialogWithSubtitle.querySelector('.gm-ui-dialog-wrap');
      const describedById = card.getAttribute('aria-describedby');
      expect(describedById).toBe('sub-dlg-subtitle');
      const subtitleEl = card.querySelector('#' + describedById);
      expect(subtitleEl).not.toBeNull();
      expect(subtitleEl.textContent).toBe('Secondary hint text');
    });

    it('adds aria-label to header close button and aria-hidden="true" to icons', () => {
      const dialog = createDialog({
        title: 'Settings',
        iconClass: 'ph-gear',
        body: 'Body',
        cancelLabel: 'Dismiss',
      });

      const closeBtn = dialog.querySelector('.gm-ui-dialog-header-close');
      expect(closeBtn.getAttribute('aria-label')).toBe('Dismiss');

      const icons = dialog.querySelectorAll('i');
      icons.forEach((icon) => {
        expect(icon.getAttribute('aria-hidden')).toBe('true');
      });
    });
  });

  describe('Focus Management & Focus Trap (openDialog)', () => {
    it('saves and restores focus to the previously focused element upon close (WCAG 2.4.3)', () => {
      const trigger = document.getElementById('trigger-btn');
      trigger.focus();
      expect(document.activeElement).toBe(trigger);

      const dialog = openDialog({
        title: 'Focus Test',
        body: '<input id="test-input" type="text"><button id="inner-btn">Submit</button>',
        confirmLabel: 'Confirm',
        cancelLabel: 'Cancel',
      });

      // Dialog opens, focus is moved inside the dialog card
      const card = dialog.querySelector('.gm-ui-dialog-wrap');
      expect(card.contains(document.activeElement)).toBe(true);

      // Close dialog
      closeDialog(dialog);

      // Focus must return to trigger
      expect(document.activeElement).toBe(trigger);
    });

    it('applies aria-hidden="true" to #app while open, and restores it on close', () => {
      const app = document.getElementById('app');
      expect(app.getAttribute('aria-hidden')).toBeNull();

      const dialog = openDialog({
        title: 'Inert Background Test',
        body: 'Testing background accessibility',
      });

      expect(app.getAttribute('aria-hidden')).toBe('true');

      closeDialog(dialog);

      expect(app.getAttribute('aria-hidden')).toBeNull();
    });

    it('traps focus inside the dialog cycling on Tab and Shift+Tab', () => {
      const dialog = openDialog({
        title: 'Focus Trap',
        body: '<input id="field-1" type="text"><input id="field-2" type="text">',
      });

      const card = dialog.querySelector('.gm-ui-dialog-wrap');
      const focusables = Array.from(card.querySelectorAll('input, button:not([disabled])'));
      expect(focusables.length).toBeGreaterThanOrEqual(2);

      const firstEl = focusables[0];
      const lastEl = focusables[focusables.length - 1];

      // Tab on last element wraps to first
      lastEl.focus();
      expect(document.activeElement).toBe(lastEl);

      const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      document.dispatchEvent(tabEvent);
      expect(document.activeElement).toBe(firstEl);

      // Shift+Tab on first element wraps to last
      firstEl.focus();
      const shiftTabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(shiftTabEvent);
      expect(document.activeElement).toBe(lastEl);
    });

    it('closes on Escape key and triggers onCancel and onClose', () => {
      const onCancel = vi.fn();
      const onClose = vi.fn();

      const _dialog = openDialog({
        title: 'Escape Test',
        body: 'Press escape to close',
        onCancel,
        onClose,
      });

      const escEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      document.dispatchEvent(escEvent);

      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(document.querySelector('.gm-ui-dialog-backdrop')).toBeNull();
    });
  });

  describe('Static Accessibility Verification on index.html', () => {
    // The admin markup ships in the admin chunk; appHtml() mounts it as startAdmin() does.
    const html = appHtml();

    it('ocr-modal-overlay contains role="dialog", aria-modal="true", and aria-labelledby', () => {
      expect(html).toContain('id="ocr-modal-overlay"');
      expect(html).toContain(
        'role="dialog" aria-modal="true" aria-labelledby="ocr-modal-title" aria-describedby="ocr-modal-subtitle"'
      );
      expect(html).toMatch(/id="ocr-modal-close" aria-label="Close"/);
    });

    it('logout-btn contains accessible aria-label', () => {
      expect(html).toMatch(/id="logout-btn"[^>]*aria-label="Logout"/);
    });

    it('all custom message action buttons have aria-label="Customize messages"', () => {
      const matches = html.match(/data-custom-msg="[^"]+"/g);
      expect(matches).not.toBeNull();
      expect(matches.length).toBeGreaterThanOrEqual(4);

      // Verify each occurrence has aria-label="Customize messages"
      const buttonMatches = html.match(/<button[^>]*data-custom-msg=[^>]*>/g);
      buttonMatches.forEach((btnHtml) => {
        expect(btnHtml).toContain('aria-label="Customize messages"');
      });
    });
  });
});
