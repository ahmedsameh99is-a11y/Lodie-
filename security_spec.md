# LOODY Firestore Security Specification (Phase 0)

## 1. Data Invariants
1. **Default-Deny Baseline**: Every unspecified document path is denied (`allow read, write: if false`).
2. **Identity Integrity**: Every user-owned document stores `ownerId == request.auth.uid`. `ownerId` is immutable after creation (`incoming().ownerId == existing().ownerId`).
3. **Self-Assigned Privilege Prevention**: Client writes to `/users/{userId}` are strictly constrained to `role == 'user'` and `plan == 'free'`, and updates cannot touch `role`, `plan`, `ownerId`, or `createdAt`.
4. **PII Isolation**: User email addresses reside exclusively inside `/users/{userId}/private/{docId}` and are readable/writable only by `request.auth.uid == userId`.
5. **Relational Master Gate**: Subcollections `/projects/{projectId}/files/{fileId}` and `/conversations/{conversationId}/messages/{messageId}` validate ownership via `get()` on the parent document during single-doc reads/writes, and never use `get()`/`exists()` inside `allow list`.
6. **Verified Auth Mandate**: Write operations require authenticated users with `request.auth.token.email_verified == true`.
7. **Temporal Integrity**: `createdAt` must equal `request.time` on create and remain immutable on update; `updatedAt` must equal `request.time` on create and update.
8. **Size & Type Bounds**: Every string field enforces explicit `.size()` limits; document IDs match `^[a-zA-Z0-9_\-]+$` up to 128 characters; bounded arrays (`enabledTools.size() <= 16`).

## 2. Dirty Dozen Attack Payloads (All Must Yield PERMISSION_DENIED)
1. **Unauthenticated Read**: Read `/conversations/conv_1` with `request.auth == null`.
2. **Privilege Escalation on Signup**: Create `/users/u1` with `{ role: 'developer', plan: 'developer', ... }`.
3. **Role Tampering on Update**: Update `/users/u1` modifying `affectedKeys()` to include `plan: 'premium'`.
4. **Shadow Field Injection**: Create `/projects/p1` with extra ghost field `isVerified: true` (blocked by `hasOnly`).
5. **Cross-Tenant Ownership Spoof**: Create `/conversations/c1` as `u2` with `ownerId: 'u1'`.
6. **Orphaned Subcollection Write**: Create `/projects/nonexistent/files/f1` as `u1` (`exists()`/`get()` parent check fails).
7. **Cross-Tenant Parent Subcollection Write**: Create `/conversations/c_owned_by_u1/messages/m1` as `u2`.
8. **PII Leak Attempt**: Read `/users/u1/private/account` as signed-in `u2`.
9. **Blanket Collection Query Scrape**: List `/conversations` without filtering `where('ownerId', '==', uid)`.
10. **ID Poisoning**: Create `/projects/` + 500-char string or `/` or `$` invalid ID.
11. **Denial-of-Wallet String Exhaustion**: Create `/conversations/c1` with 50KB `title`.
12. **Timestamp Backdating / Unverified Email**: Create `/projects/p1` with `email_verified: false` or spoofed `createdAt`.
13. **Cross-Tenant Memory / RAG Scraping**: Read `/user_memories/{id}` or `/knowledge_sources/{id}` owned by another user (`ownerId != request.auth.uid`), or inject `approved`/`createdAt` backdating.
