import { PrismaAdapter } from "@next-auth/prisma-adapter";
import { NextAuthOptions } from "next-auth";
import EmailProvider from "next-auth/providers/email";
import GithubProvider from "next-auth/providers/github";
import GoogleProvider from "next-auth/providers/google";
import { OrgInfo } from "tier";

import { env } from "@/env.mjs";
import { siteConfig } from "@/config/site";
import { tierConstants } from "@/config/tierConstants";
import { db } from "@/lib/db";
import { postmarkClient } from "@/lib/email";
import { tier } from "@/lib/tier";

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(db as any),
  session: {
    strategy: "jwt",
  },
  pages: {
    signIn: "/login",
  },
  providers: [
    GithubProvider({
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    }),
    EmailProvider({
      from: env.SMTP_FROM,
      sendVerificationRequest: async ({ identifier, url, provider }) => {
        const user = await db.user.findUnique({
          where: {
            email: identifier,
          },
          select: {
            emailVerified: true,
          },
        });

        const templateId = user?.emailVerified
          ? env.POSTMARK_SIGN_IN_TEMPLATE
          : env.POSTMARK_ACTIVATION_TEMPLATE;

        if (!templateId) {
          throw new Error("Missing template id");
        }

        const result = await postmarkClient.sendEmailWithTemplate({
          TemplateId: parseInt(templateId),
          To: identifier,
          From: provider.from as string,
          TemplateModel: {
            action_url: url,
            product_name: siteConfig.name,
          },
          Headers: [
            {
              // Set this to prevent Gmail from threading emails.
              // See https://stackoverflow.com/questions/23434110/force-emails-not-to-be-grouped-into-conversations/25435722.
              Name: "X-Entity-Ref-ID",
              Value: new Date().getTime() + "",
            },
          ],
        });

        if (result.ErrorCode) {
          throw new Error(result.Message);
        }
      },
    }),
  ],
  callbacks: {
    async session({ token, session }) {
      if (token) {
        session.user.id = token.id;
        session.user.name = token.name;
        session.user.email = token.email;
        session.user.image = token.picture;

        // Check if there are any plans, else subscribe to the free plan
        try {
          const limits = await tier.lookupLimit(
            `org:${session?.user?.id}`,
            tierConstants.TIER_AICOPY_FEATURE_ID
          );
          console.log(limits);
          session.user.limit = limits;
        } catch (error) {
          await tier.subscribe(
            `org:${session?.user?.id}`,
            tierConstants.TIER_FREE_PLAN_ID,
            {
              info: {
                name: session?.user?.name as string,
                email: session?.user?.email as string,
              } as OrgInfo,
            }
          );
          try {
            const limits = await tier.lookupLimit(
              `org:${session?.user?.id}`,
              tierConstants.TIER_AICOPY_FEATURE_ID
            );
            session.user.limit = limits;
          } catch (error) {
            session.user.limit = {
              feature: tierConstants.TIER_AICOPY_FEATURE_ID,
              used: 0,
              limit: 1,
            };
            console.log("No Limits found for the first time user subscription");
          }
        } finally {
          return session;
        }
      }

      return session;
    },
    async jwt({ token, user }) {
      const dbUser = await db.user.findFirst({
        where: {
          email: token.email,
        },
      });

      if (!dbUser) {
        if (user) {
          token.id = user?.id;
        }
        return token;
      }

      return {
        id: dbUser.id,
        name: dbUser.name,
        email: dbUser.email,
        picture: dbUser.image,
      };
    },
  },
};
