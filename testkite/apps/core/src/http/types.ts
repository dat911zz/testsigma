/**
 * Kiểu của TẦNG SHELL HTTP. Module nghiệp vụ import từ đây (một chiều: shell không
 * import ngược vào trong module nào ngoài facade).
 */
import type { z } from "zod";
import type { RouteDescriptor } from "@testkite/contract";
import type { CredentialKind, MembershipRole, Permission } from "../modules/identity/index.js";

/**
 * Bối cảnh của MỘT request. `teamId` ở đây là nguồn sự thật duy nhất về tenant —
 * nó đến từ credential, KHÔNG BAO GIỜ từ path/query/body (Global Constraints).
 */
export type RequestContext = {
  readonly teamId: string;
  readonly userId: string | null;
  readonly tokenId: string;
  readonly authKind: CredentialKind;
  readonly role: MembershipRole;
  readonly scopes: readonly Permission[];
};

type InferOr<T, F> = T extends z.ZodTypeAny ? z.infer<T> : F;

export type RouteInput<D extends RouteDescriptor> = {
  readonly ctx: RequestContext;
  readonly params: InferOr<D["params"], Record<string, never>>;
  readonly query: InferOr<D["query"], Record<string, never>>;
  readonly body: InferOr<D["body"], undefined>;
};

/**
 * Route `auth: "public"` (đăng nhập, OIDC callback) chạy KHI CHƯA có credential —
 * ở đó `RequestContext` chưa tồn tại. Thay vì nới `ctx` thành `RequestContext | null`
 * cho mọi handler (bắt ~50 handler sau này phải tự kiểm null, và chỉ cần quên MỘT
 * lần là tenant đến từ chỗ khác credential), input của route public đơn giản KHÔNG
 * có `ctx`. Kiểu ép đúng chuyện đó: handler public không thể đọc bối cảnh không có.
 */
export type PublicRouteInput<D extends RouteDescriptor> = Omit<RouteInput<D>, "ctx">;

export type RouteRegistration =
  | {
      readonly auth: "required";
      readonly descriptor: RouteDescriptor;
      readonly handler: (input: RouteInput<RouteDescriptor>) => Promise<unknown>;
    }
  | {
      readonly auth: "public";
      readonly descriptor: RouteDescriptor;
      readonly handler: (input: PublicRouteInput<RouteDescriptor>) => Promise<unknown>;
    };

/**
 * Ghép descriptor (hợp đồng, ở @testkite/contract) với handler (nghiệp vụ, ở module).
 * Giữ được kiểu tại chỗ định nghĩa; ở registry thì thu về RouteRegistration.
 */
export function route<D extends RouteDescriptor>(
  descriptor: D,
  handler: (input: RouteInput<D>) => Promise<unknown>,
): RouteRegistration {
  // Descriptor public + handler đòi ctx = 401 vĩnh viễn trên một route đáng lẽ mở.
  // Bắt ngay lúc dựng app, không để phát hiện bằng một bug production.
  if (descriptor.auth === "public") {
    throw new Error(`route(): ${descriptor.operationId} là route public — dùng publicRoute()`);
  }
  return { auth: "required", descriptor, handler } as RouteRegistration;
}

/** Đối ngẫu của `route()` cho descriptor `auth: "public"`. */
export function publicRoute<D extends RouteDescriptor>(
  descriptor: D,
  handler: (input: PublicRouteInput<D>) => Promise<unknown>,
): RouteRegistration {
  if (descriptor.auth !== "public") {
    throw new Error(`publicRoute(): ${descriptor.operationId} đòi xác thực — dùng route()`);
  }
  return { auth: "public", descriptor, handler } as RouteRegistration;
}

declare module "fastify" {
  interface FastifyRequest {
    /** null trên route public; hook auth gán trước mọi handler cho route required. */
    tk: RequestContext | null;
  }

  /**
   * Descriptor hợp đồng đi kèm route, đọc lại được trong hook `onRequest`
   * (`req.routeOptions.config.tk`). Fastify để `FastifyContextConfig` rỗng đúng
   * cho mục đích này — khai ở đây thì cả route kiểu `RouteRegistration` lẫn route
   * kiểu `FastifyPluginAsync` (plan authoring) cùng nói một hợp đồng, không cast.
   */
  interface FastifyContextConfig {
    readonly tk?: RouteDescriptor;
  }

  interface FastifyInstance {
    /** Mọi route router đang phục vụ + route đó có descriptor hợp đồng hay không. */
    tkRegisteredRoutes: { method: string; url: string; hasDescriptor: boolean }[];
  }
}
