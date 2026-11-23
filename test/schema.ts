import { relations } from 'drizzle-orm';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const authors = sqliteTable('authors', {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text(),
  body: text().notNull(),
});

export const posts = sqliteTable('posts', {
  id: text().primaryKey(),
  title: text().notNull(),
  author: text().notNull(),
  published: integer({ mode: 'timestamp' }).notNull(),
  draft: integer({ mode: 'boolean' }).notNull().default(false),
  views: integer().notNull().default(0),
  rating: real(),
  tags: text({ mode: 'json' })
    .$type<string[]>()
    .notNull()
    .$defaultFn(() => []),
  meta: text({ mode: 'json' }).$type<{ readingTime: number }>(),
  status: text({ enum: ['idea', 'published'] }),
  body: text().notNull(),
});

export const authorsRelations = relations(authors, ({ many }) => ({ posts: many(posts) }));

export const postsRelations = relations(posts, ({ one }) => ({
  writer: one(authors, { fields: [posts.author], references: [authors.id] }),
}));

export const schema = { authors, posts, authorsRelations, postsRelations };
