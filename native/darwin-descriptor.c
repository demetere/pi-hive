#include <node_api.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef PI_HIVE_NATIVE_SOURCE_SHA256
#define PI_HIVE_NATIVE_SOURCE_SHA256 "unversioned"
#endif

static const char *errno_code(int value) {
  switch (value) {
    case EACCES: return "EACCES";
    case EEXIST: return "EEXIST";
    case EINVAL: return "EINVAL";
    case EIO: return "EIO";
    case EISDIR: return "EISDIR";
    case ELOOP: return "ELOOP";
    case EMFILE: return "EMFILE";
    case ENAMETOOLONG: return "ENAMETOOLONG";
    case ENFILE: return "ENFILE";
    case ENOENT: return "ENOENT";
    case ENOTDIR: return "ENOTDIR";
    case ENOTEMPTY: return "ENOTEMPTY";
    case EPERM: return "EPERM";
    case EROFS: return "EROFS";
    default: return "EUNKNOWN";
  }
}

static napi_value throw_errno(napi_env env, const char *operation) {
  const int captured = errno;
  char message[512];
  snprintf(message, sizeof(message), "%s failed: %s", operation, strerror(captured));
  napi_value message_value, error, code, number;
  napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &message_value);
  napi_create_error(env, NULL, message_value, &error);
  napi_create_string_utf8(env, errno_code(captured), NAPI_AUTO_LENGTH, &code);
  napi_set_named_property(env, error, "code", code);
  napi_create_int32(env, captured, &number);
  napi_set_named_property(env, error, "errno", number);
  napi_throw(env, error);
  return NULL;
}

static bool int_arg(napi_env env, napi_value value, int *output) {
  int32_t parsed;
  if (napi_get_value_int32(env, value, &parsed) != napi_ok) {
    napi_throw_type_error(env, NULL, "Expected an integer descriptor or flag");
    return false;
  }
  *output = parsed;
  return true;
}

static bool component_arg(napi_env env, napi_value value, char *output, size_t capacity) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, output, capacity, &length) != napi_ok) {
    napi_throw_type_error(env, NULL, "Expected a UTF-8 path component");
    return false;
  }
  if (length == 0 || length >= capacity || strlen(output) != length || strcmp(output, ".") == 0 || strcmp(output, "..") == 0 || strchr(output, '/') != NULL || strchr(output, '\\') != NULL) {
    napi_throw_range_error(env, NULL, "Descriptor operation path must be one safe component");
    return false;
  }
  return true;
}

static napi_value open_at(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 3) { napi_throw_type_error(env, NULL, "openAt requires directory descriptor, component, and flags"); return NULL; }
  int directory, flags, mode = 0;
  char component[NAME_MAX + 1];
  if (!int_arg(env, argv[0], &directory) || !component_arg(env, argv[1], component, sizeof(component)) || !int_arg(env, argv[2], &flags)) return NULL;
  if (argc > 3 && !int_arg(env, argv[3], &mode)) return NULL;
  int descriptor;
  do { descriptor = openat(directory, component, flags, (mode_t)mode); } while (descriptor < 0 && errno == EINTR);
  if (descriptor < 0) return throw_errno(env, "openat");
  napi_value result;
  napi_create_int32(env, descriptor, &result);
  return result;
}

static napi_value mkdir_at(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int directory, mode;
  char component[NAME_MAX + 1];
  if (argc != 3 || !int_arg(env, argv[0], &directory) || !component_arg(env, argv[1], component, sizeof(component)) || !int_arg(env, argv[2], &mode)) return NULL;
  int result;
  do { result = mkdirat(directory, component, (mode_t)mode); } while (result < 0 && errno == EINTR);
  if (result < 0) return throw_errno(env, "mkdirat");
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value rename_at(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int source_directory, target_directory;
  char source[NAME_MAX + 1], target[NAME_MAX + 1];
  if (argc != 4 || !int_arg(env, argv[0], &source_directory) || !component_arg(env, argv[1], source, sizeof(source)) || !int_arg(env, argv[2], &target_directory) || !component_arg(env, argv[3], target, sizeof(target))) return NULL;
  int result;
  do { result = renameat(source_directory, source, target_directory, target); } while (result < 0 && errno == EINTR);
  if (result < 0) return throw_errno(env, "renameat");
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value unlink_at(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int directory, flags;
  char component[NAME_MAX + 1];
  if (argc != 3 || !int_arg(env, argv[0], &directory) || !component_arg(env, argv[1], component, sizeof(component)) || !int_arg(env, argv[2], &flags)) return NULL;
  int result;
  do { result = unlinkat(directory, component, flags); } while (result < 0 && errno == EINTR);
  if (result < 0) return throw_errno(env, "unlinkat");
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value link_at(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int source_directory, target_directory, flags;
  char source[NAME_MAX + 1], target[NAME_MAX + 1];
  if (argc != 5 || !int_arg(env, argv[0], &source_directory) || !component_arg(env, argv[1], source, sizeof(source)) || !int_arg(env, argv[2], &target_directory) || !component_arg(env, argv[3], target, sizeof(target)) || !int_arg(env, argv[4], &flags)) return NULL;
  int result;
  do { result = linkat(source_directory, source, target_directory, target, flags); } while (result < 0 && errno == EINTR);
  if (result < 0) return throw_errno(env, "linkat");
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static void set_string_property(napi_env env, napi_value object, const char *name, const char *value) {
  napi_value encoded;
  napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &encoded);
  napi_set_named_property(env, object, name, encoded);
}

static napi_value stat_at(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int directory;
  char component[NAME_MAX + 1];
  if (argc != 2 || !int_arg(env, argv[0], &directory) || !component_arg(env, argv[1], component, sizeof(component))) return NULL;
  struct stat status;
  int result;
  do { result = fstatat(directory, component, &status, AT_SYMLINK_NOFOLLOW); } while (result < 0 && errno == EINTR);
  if (result < 0) return throw_errno(env, "fstatat");
  napi_value output;
  napi_create_object(env, &output);
  const char *kind = S_ISREG(status.st_mode) ? "file" : S_ISDIR(status.st_mode) ? "directory" : S_ISLNK(status.st_mode) ? "symlink" : "other";
  set_string_property(env, output, "kind", kind);
  char encoded[64];
  snprintf(encoded, sizeof(encoded), "%llu", (unsigned long long)status.st_dev);
  set_string_property(env, output, "device", encoded);
  snprintf(encoded, sizeof(encoded), "%llu", (unsigned long long)status.st_ino);
  set_string_property(env, output, "inode", encoded);
  snprintf(encoded, sizeof(encoded), "%llu", (unsigned long long)status.st_size);
  set_string_property(env, output, "size", encoded);
  snprintf(encoded, sizeof(encoded), "%lld", (long long)status.st_mtimespec.tv_sec * 1000000000LL + status.st_mtimespec.tv_nsec);
  set_string_property(env, output, "mtimeNs", encoded);
  return output;
}

static napi_value descriptor_path(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int descriptor;
  if (argc != 1 || !int_arg(env, argv[0], &descriptor)) return NULL;
  char path[PATH_MAX];
  if (fcntl(descriptor, F_GETPATH, path) < 0) return throw_errno(env, "fcntl(F_GETPATH)");
  napi_value result;
  napi_create_string_utf8(env, path, NAPI_AUTO_LENGTH, &result);
  return result;
}

static napi_value read_directory(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int descriptor;
  if (argc != 1 || !int_arg(env, argv[0], &descriptor)) return NULL;
  int duplicate = dup(descriptor);
  if (duplicate < 0) return throw_errno(env, "dup");
  DIR *directory = fdopendir(duplicate);
  if (directory == NULL) { close(duplicate); return throw_errno(env, "fdopendir"); }
  rewinddir(directory);
  napi_value entries;
  napi_create_array(env, &entries);
  uint32_t index = 0;
  errno = 0;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    napi_value name;
    napi_create_string_utf8(env, entry->d_name, NAPI_AUTO_LENGTH, &name);
    napi_set_element(env, entries, index++, name);
  }
  int read_errno = errno;
  closedir(directory);
  if (read_errno != 0) { errno = read_errno; return throw_errno(env, "readdir"); }
  return entries;
}

static napi_value source_hash(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result;
  napi_create_string_utf8(env, PI_HIVE_NATIVE_SOURCE_SHA256, NAPI_AUTO_LENGTH, &result);
  return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    { "sourceHash", NULL, source_hash, NULL, NULL, NULL, napi_default, NULL },
    { "openAt", NULL, open_at, NULL, NULL, NULL, napi_default, NULL },
    { "mkdirAt", NULL, mkdir_at, NULL, NULL, NULL, napi_default, NULL },
    { "renameAt", NULL, rename_at, NULL, NULL, NULL, napi_default, NULL },
    { "unlinkAt", NULL, unlink_at, NULL, NULL, NULL, napi_default, NULL },
    { "linkAt", NULL, link_at, NULL, NULL, NULL, napi_default, NULL },
    { "statAt", NULL, stat_at, NULL, NULL, NULL, napi_default, NULL },
    { "descriptorPath", NULL, descriptor_path, NULL, NULL, NULL, napi_default, NULL },
    { "readDirectory", NULL, read_directory, NULL, NULL, NULL, napi_default, NULL },
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
