/**
 * notes.js — Local localStorage-based notes CRUD.
 * Replaces server-side MongoDB Note model. Zero network calls.
 *
 * Exposes window.NotesAPI globally.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'daily_briefing_notes';

  // --- Storage helpers ---

  function readAll() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function writeAll(notes) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
    } catch (e) { /* storage full */ }
  }

  function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // --- CRUD ---

  /**
   * List all notes, newest first.
   * @returns {Promise<Array>} array of { _id, text, done, createdAt }
   */
  function list() {
    var notes = readAll();
    notes.sort(function (a, b) {
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
    return Promise.resolve(notes);
  }

  /**
   * Add a new note.
   * @param {string} text
   * @returns {Promise<Object>} the created note
   */
  function add(text) {
    if (!text || !text.trim()) return Promise.reject(new Error('text required'));
    var notes = readAll();
    var note = {
      _id: genId(),
      text: text.trim(),
      done: false,
      createdAt: new Date().toISOString()
    };
    notes.push(note);
    writeAll(notes);
    return Promise.resolve(note);
  }

  /**
   * Toggle done/not-done.
   * @param {string} id
   * @returns {Promise<Object>} the updated note
   */
  function toggle(id) {
    var notes = readAll();
    var note = notes.find(function (n) { return n._id === id; });
    if (!note) return Promise.reject(new Error('Not found'));
    note.done = !note.done;
    writeAll(notes);
    return Promise.resolve(note);
  }

  /**
   * Delete a note.
   * @param {string} id
   * @returns {Promise<Object>} { success: true }
   */
  function remove(id) {
    var notes = readAll();
    var filtered = notes.filter(function (n) { return n._id !== id; });
    if (filtered.length === notes.length) return Promise.reject(new Error('Not found'));
    writeAll(filtered);
    return Promise.resolve({ success: true });
  }

  // --- Expose globally ---

  window.NotesAPI = {
    list: list,
    add: add,
    toggle: toggle,
    remove: remove
  };
})();
