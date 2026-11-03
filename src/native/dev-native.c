#include <errno.h>
#include <fcntl.h>
#include <node_api.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/attr.h>
#include <sys/mount.h>
#include <sys/param.h>
#include <sys/proc.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <unistd.h>
#include <uuid/uuid.h>

#define PROCESS_COLUMNS 5
#define PROCESS_READ_ATTEMPTS 8

typedef struct {
  uint32_t length;
  uuid_t uuid;
} __attribute__((packed)) VolumeUuidReply;

static napi_value fail(napi_env env, const char *call, int code) {
  char message[256];
  snprintf(message, sizeof message, "%s: %s", call, strerror(code));
  napi_throw_error(env, NULL, message);
  return NULL;
}

static napi_value reject(napi_env env, const char *message) {
  napi_throw_error(env, NULL, message);
  return NULL;
}

#define REQUIRE(call)                                                          \
  do {                                                                         \
    if ((call) != napi_ok) return reject(env, "Node-API call failed: " #call); \
  } while (0)

static bool read_path(napi_env env, napi_callback_info info, char *path, napi_value *failure) {
  size_t argc = 1;
  napi_value argv[1];
  size_t length = 0;
  *failure = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1 ||
      napi_get_value_string_utf8(env, argv[0], NULL, 0, &length) != napi_ok) {
    *failure = reject(env, "A path string is required");
    return false;
  }
  if (length >= PATH_MAX) {
    *failure = reject(env, "The path is too long");
    return false;
  }
  if (napi_get_value_string_utf8(env, argv[0], path, PATH_MAX, &length) != napi_ok) {
    *failure = reject(env, "Cannot read the path string");
    return false;
  }
  if (memchr(path, '\0', length) != NULL) {
    *failure = reject(env, "The path contains a NUL byte");
    return false;
  }
  return true;
}

static napi_value text(napi_env env, const char *value) {
  napi_value result = NULL;
  if (napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result) != napi_ok)
    return reject(env, "Node-API call failed: napi_create_string_utf8");
  return result;
}

static napi_value observe_directory(napi_env env, napi_callback_info info) {
  char path[PATH_MAX];
  napi_value failure;
  if (!read_path(env, info, path, &failure)) return failure;
  int fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return fail(env, "open", errno);
  struct stat stat;
  if (fstat(fd, &stat) != 0) {
    int code = errno;
    close(fd);
    return fail(env, "fstat", code);
  }
  struct attrlist request;
  memset(&request, 0, sizeof request);
  request.bitmapcount = ATTR_BIT_MAP_COUNT;
  request.volattr = ATTR_VOL_INFO | ATTR_VOL_UUID;
  VolumeUuidReply reply;
  if (fgetattrlist(fd, &request, &reply, sizeof reply, 0) != 0) {
    int code = errno;
    close(fd);
    return fail(env, "fgetattrlist", code);
  }
  close(fd);
  char device[32];
  char inode[32];
  char uuid[37];
  snprintf(device, sizeof device, "%llu", (unsigned long long)(uint64_t)stat.st_dev);
  snprintf(inode, sizeof inode, "%llu", (unsigned long long)stat.st_ino);
  uuid_unparse_upper(reply.uuid, uuid);
  napi_value result;
  REQUIRE(napi_create_array_with_length(env, 3, &result));
  REQUIRE(napi_set_element(env, result, 0, text(env, device)));
  REQUIRE(napi_set_element(env, result, 1, text(env, inode)));
  REQUIRE(napi_set_element(env, result, 2, text(env, uuid)));
  return result;
}

static napi_value filesystem(napi_env env, napi_callback_info info) {
  char path[PATH_MAX];
  napi_value failure;
  if (!read_path(env, info, path, &failure)) return failure;
  struct statfs fs;
  if (statfs(path, &fs) != 0) return fail(env, "statfs", errno);
  napi_value result;
  napi_value local;
  REQUIRE(napi_create_array_with_length(env, 3, &result));
  REQUIRE(napi_get_boolean(env, (fs.f_flags & MNT_LOCAL) != 0, &local));
  REQUIRE(napi_set_element(env, result, 0, text(env, fs.f_fstypename)));
  REQUIRE(napi_set_element(env, result, 1, local));
  REQUIRE(napi_set_element(env, result, 2, text(env, fs.f_mntonname)));
  return result;
}

static napi_value process_table(napi_env env, napi_callback_info info) {
  (void)info;
  int mib[3] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL};
  struct kinfo_proc *procs = NULL;
  size_t size = 0;
  bool read = false;
  for (int attempt = 0; attempt < PROCESS_READ_ATTEMPTS && !read; attempt += 1) {
    if (sysctl(mib, 3, NULL, &size, NULL, 0) != 0) {
      int code = errno;
      free(procs);
      return fail(env, "sysctl size", code);
    }
    size += size / 4 + sizeof *procs * 16;
    struct kinfo_proc *grown = realloc(procs, size);
    if (grown == NULL) {
      free(procs);
      return fail(env, "realloc", ENOMEM);
    }
    procs = grown;
    if (sysctl(mib, 3, procs, &size, NULL, 0) == 0) {
      read = true;
    } else if (errno != ENOMEM) {
      int code = errno;
      free(procs);
      return fail(env, "sysctl", code);
    }
  }
  if (!read) {
    free(procs);
    return fail(env, "sysctl", ENOMEM);
  }
  size_t count = size / sizeof *procs;
  size_t live = 0;
  for (size_t index = 0; index < count; index += 1)
    if (procs[index].kp_proc.p_stat != SZOMB) live += 1;
  napi_value buffer;
  napi_value array;
  double *rows = NULL;
  if (napi_create_arraybuffer(env, live * PROCESS_COLUMNS * sizeof(double), (void **)&rows, &buffer) != napi_ok) {
    free(procs);
    return reject(env, "Node-API call failed: napi_create_arraybuffer");
  }
  size_t row = 0;
  for (size_t index = 0; index < count; index += 1) {
    const struct kinfo_proc *item = &procs[index];
    if (item->kp_proc.p_stat == SZOMB) continue;
    double *out = rows + row * PROCESS_COLUMNS;
    out[0] = item->kp_proc.p_pid;
    out[1] = item->kp_eproc.e_ppid;
    out[2] = item->kp_eproc.e_pgid;
    out[3] = (double)item->kp_proc.p_starttime.tv_sec;
    out[4] = item->kp_proc.p_starttime.tv_usec;
    row += 1;
  }
  free(procs);
  REQUIRE(napi_create_typedarray(env, napi_float64_array, live * PROCESS_COLUMNS, buffer, 0, &array));
  return array;
}

NAPI_MODULE_INIT() {
  napi_value function;
  REQUIRE(napi_create_function(env, "observeDirectory", NAPI_AUTO_LENGTH, observe_directory, NULL, &function));
  REQUIRE(napi_set_named_property(env, exports, "observeDirectory", function));
  REQUIRE(napi_create_function(env, "filesystem", NAPI_AUTO_LENGTH, filesystem, NULL, &function));
  REQUIRE(napi_set_named_property(env, exports, "filesystem", function));
  REQUIRE(napi_create_function(env, "processTable", NAPI_AUTO_LENGTH, process_table, NULL, &function));
  REQUIRE(napi_set_named_property(env, exports, "processTable", function));
  return exports;
}
