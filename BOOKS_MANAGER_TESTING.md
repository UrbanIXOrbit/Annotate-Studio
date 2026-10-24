# Books Manager - Testing Guide

## Quick Start Testing

Once you've implemented the Rust backend, follow this testing sequence.

## 1. Basic Functionality Tests

### Test 1: Create Project
1. Open app and navigate to Books tab (sidebar or Ctrl+3)
2. Click "+ New" in Projects sidebar
3. Type "Test Project" and click Create
4. **Expected**: New project appears and becomes active

### Test 2: Create Folders
1. With "Test Project" selected
2. Click "+ Folder" in folder tree
3. Type "Documents" and click Create
4. Select "Documents" folder
5. Click "+ Folder" again
6. Type "Subfolder" and click Create
7. **Expected**: Nested folder structure appears

### Test 3: Import Files
1. Select "Documents" folder
2. Click "Import Files" button
3. Select 2-3 PDF or text files from your computer
4. **Expected**: Files appear in file list with correct names and sizes

### Test 4: File Operations
1. Click a file to select it
2. Click "..." menu → Rename
3. Change the display name
4. Click "..." menu → Add tag
5. Add tags like "important", "work"
6. **Expected**: Changes persist and appear immediately

### Test 5: Move Files
1. Select multiple files (checkboxes)
2. Create a new folder "Archive"
3. Drag files to "Archive" folder (or use move action)
4. **Expected**: Files move between folders

### Test 6: Search
1. Type in search box at top
2. Try searching: file names, tags, notes
3. **Expected**: Matching files appear across all projects

## 2. Edge Case Tests

### Test 7: Delete Operations
1. Delete a file reference
2. Check the actual file on disk
3. **Expected**: File still exists, only reference removed

### Test 8: Delete Project
1. Create a project with folders and files
2. Delete the project
3. Check disk for actual files
4. **Expected**: Only references removed, files intact

### Test 9: Persistence
1. Import files, create folders
2. Close the app completely
3. Reopen the app
4. Navigate to Books tab
5. **Expected**: All data restored exactly as left

### Test 10: Invalid Files
1. Import files normally
2. Manually delete one of the actual files from disk
3. Try to open it from Books Manager
4. **Expected**: Graceful error message, app doesn't crash

### Test 11: Nested Folder Limits
1. Create folders nested 5+ levels deep
2. Import files at various levels
3. Move folders between parents
4. **Expected**: No performance issues, all operations work

### Test 12: Large File Lists
1. Import 50+ files into one folder
2. Scroll through list
3. Search within large list
4. **Expected**: Smooth performance, no lag

## 3. UI/UX Tests

### Test 13: Responsive Layout
1. Resize window to various sizes
2. Check all three panels adjust properly
3. Test collapsed/expanded sidebar
4. **Expected**: Layout remains usable at all sizes

### Test 14: Keyboard Navigation
1. Use Tab to navigate between elements
2. Use Enter to activate buttons
3. Use Escape to close dialogs
4. **Expected**: Full keyboard accessibility

### Test 15: Visual Feedback
1. Hover over items
2. Click selections
3. Drag operations
4. **Expected**: Clear visual states (hover, active, selected)

## 4. Data Integrity Tests

### Test 16: Concurrent Operations
1. Import files while searching
2. Move folders while files are selected
3. Rename project while viewing its files
4. **Expected**: No data loss, operations complete

### Test 17: Special Characters
1. Create project with name: "Test & Special <>"
2. Create folder with emojis: "📚 Books"
3. Import file with spaces and Unicode
4. **Expected**: All names display correctly

### Test 18: Path Handling
1. Import files from different drives (Windows: C:, D:)
2. Import files with very long paths
3. Import files from network drives
4. **Expected**: Paths stored and resolved correctly

## 5. Integration Tests

### Test 19: Open on Canvas
1. Import a PDF file
2. Right-click or double-click
3. Select "Open on Canvas"
4. **Expected**: PDF opens in canvas window

### Test 20: Theme Changes
1. Go to Settings
2. Change theme (light/dark/etc)
3. Return to Books Manager
4. **Expected**: Colors update properly

### Test 21: Multiple Projects
1. Create 3+ projects
2. Switch between them rapidly
3. Import files into each
4. **Expected**: Correct files shown for each project

## 6. Error Handling Tests

### Test 22: Import Non-Existent Files
1. Try to import files that don't exist
2. **Expected**: Graceful skip or error message

### Test 23: Corrupt State File
1. Close app
2. Manually corrupt books.json (add invalid JSON)
3. Reopen app
4. **Expected**: App starts with empty state, doesn't crash

### Test 24: Permissions Issues
1. Import a file
2. Change file permissions to read-only
3. Try operations on it
4. **Expected**: Appropriate error messages

## 7. Performance Tests

### Test 25: Startup Time
1. Create database with 500+ file references
2. Close and reopen app
3. Time how long Books tab takes to load
4. **Expected**: Under 2 seconds

### Test 26: Search Performance
1. Database with 500+ files
2. Type in search box
3. **Expected**: Results appear within 200ms

### Test 27: Memory Usage
1. Monitor memory before opening Books
2. Import 1000+ file references
3. Check memory after
4. **Expected**: Reasonable memory usage (< 100MB increase)

## 8. Validation Checklist

After all tests, verify:

- [ ] All file operations work without errors
- [ ] No actual files are ever moved/deleted
- [ ] State persists across app restarts
- [ ] Search returns accurate results
- [ ] No console errors during normal use
- [ ] UI remains responsive with 100+ files
- [ ] All keyboard shortcuts work
- [ ] Theme changes apply correctly
- [ ] Context menus appear correctly
- [ ] Empty states show helpful messages

## 9. Browser Console Checks

Open DevTools and check for:

- No React errors or warnings
- No TypeScript type errors
- No failed network requests
- No memory leaks (use Chrome Memory Profiler)

## 10. Accessibility Tests

1. Use screen reader (VoiceOver on Mac)
2. Navigate with keyboard only
3. Check color contrast ratios
4. **Expected**: All features accessible

## Common Issues and Fixes

### Issue: Files don't appear after import
**Check**: Rust backend returning proper metadata
**Fix**: Verify `import_external_files` command

### Issue: State doesn't persist
**Check**: books.json file location
**Fix**: Verify `save_books_state` writes to correct path

### Issue: Can't delete project
**Check**: Browser console for errors
**Fix**: Ensure proper ID handling in delete logic

### Issue: Search doesn't work
**Check**: Search input is wired to store
**Fix**: Verify `searchFiles` function in store

### Issue: Folders won't nest
**Check**: Parent/child relationship logic
**Fix**: Review `moveFolder` function for circular checks

## Success Criteria

✅ Can organize 1000+ files without lag
✅ Zero file system modifications
✅ State survives app restarts
✅ All CRUD operations work flawlessly
✅ Intuitive UX, no training needed
✅ Graceful error handling
✅ Full keyboard accessibility
✅ Theme-aware styling

## Debugging Tips

**Enable detailed logging**:
```typescript
// Add to books.ts store
const DEBUG = true;
if (DEBUG) console.log('Books action:', action, data);
```

**Check state in DevTools**:
```javascript
// In browser console
window.__BOOKS_STATE__ = useBooks.getState();
console.log(window.__BOOKS_STATE__);
```

**Verify Tauri commands**:
```typescript
// Test command directly
import { importExternalFiles } from '@/lib/tauri-commands';
importExternalFiles(['/path/to/test.pdf']).then(console.log);
```

## Final Validation

Before considering complete:

1. Run through all 27 tests
2. Fix any discovered issues
3. Test on different OS (Mac/Windows/Linux)
4. Get user feedback from 2-3 people
5. Profile performance with real data
6. Document any limitations found

**When all tests pass → Ship it! 🚀**
