import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';

export const postStatus = pgEnum('post_status', ['idea', 'published']);

export const authors = pgTable('authors', {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text(),
  body: text().notNull(),
});

export const posts = pgTable('posts', {
  id: text().primaryKey(),
  title: varchar({ length: 40 }).notNull(),
  author: text().notNull(),
  published: timestamp({ withTimezone: true }).notNull(),
  draft: boolean().notNull().default(false),
  views: integer().notNull().default(0),
  rating: doublePrecision(),
  tags: text().array().notNull().default(sql`'{}'`),
  meta: jsonb().$type<{ readingTime: number }>(),
  status: postStatus(),
  indexedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  body: text().notNull(),
});

export const authorsRelations = relations(authors, ({ many }) => ({ posts: many(posts) }));

export const postsRelations = relations(posts, ({ one }) => ({
  writer: one(authors, { fields: [posts.author], references: [authors.id] }),
}));

export const pgSchema = { postStatus, authors, posts, authorsRelations, postsRelations };
