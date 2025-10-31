import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";

// 执行系统命令的函数
function $(strings, ...values) {
  // 检查是否是直接传入字符串
  if (typeof strings === 'string') {
    const command = strings;
    console.log(command);

    return new Promise((resolve, reject) => {
      exec(command, (error, stdout, stderr) => {
        // 打印所有输出，包括stdout和stderr
        if (stdout) console.log(stdout);
        if (stderr) console.error(stderr);
        
        if (error) {
          // 在拒绝错误前打印详细信息
          console.error(`Command failed: ${command}`);
          console.error(`Error code: ${error.code}`);
          return reject(error);
        }
        return resolve({ stdout, stderr });
      });
    });
  }
  
  // 处理模板字符串
  let command = '';
  for (let i = 0; i < strings.length; i++) {
    command += strings[i];
    if (i < values.length) {
      command += values[i];
    }
  }
  
  console.log(command);

  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      // 打印所有输出，包括stdout和stderr
      if (stdout) console.log(stdout);
      if (stderr) console.error(stderr);
      
      if (error) {
        // 在拒绝错误前打印详细信息
        console.error(`Command failed: ${command}`);
        console.error(`Error code: ${error.code}`);
        return reject(error);
      }
      return resolve({ stdout, stderr });
    });
  });
}

// 删除目录（跨平台）
async function removeDir(dirPath) {
  try {
    console.log(`Removing directory: ${dirPath}`);
    await fs.rm(dirPath, { recursive: true, force: true });
    console.log(`Directory ${dirPath} removed successfully`);
  } catch (error) {
    console.error(`Error removing directory ${dirPath}:`, error.message);
  }
}

// 创建目录（跨平台）
async function createDir(dirPath) {
  try {
    console.log(`Creating directory: ${dirPath}`);
    await fs.mkdir(dirPath, { recursive: true });
    console.log(`Directory ${dirPath} created successfully`);
  } catch (error) {
    console.error(`Error creating directory ${dirPath}:`, error.message);
    throw error;
  }
}

// 复制文件（跨平台）
async function copyFile(source, destination) {
  try {
    console.log(`Copying file: ${source} to ${destination}`);
    // 确保目标目录存在，使用正确的路径分隔符处理
    const lastSlashIndex = Math.max(
      destination.lastIndexOf('/'),
      destination.lastIndexOf('\\')
    );
    const destDir = destination.substring(0, lastSlashIndex);
    if (destDir) { // 确保destDir不为空
      await createDir(destDir);
    }
    await fs.copyFile(source, destination);
    console.log(`File copied successfully`);
  } catch (error) {
    console.error(`Error copying file:`, error.message);
    throw error;
  }
}

// 移动目录内容（跨平台）
async function moveDirContents(sourceDir, destDir) {
  try {
    console.log(`Moving contents from ${sourceDir} to ${destDir}`);
    const files = await fs.readdir(sourceDir, { withFileTypes: true });
    
    for (const file of files) {
      const sourcePath = join(sourceDir, file.name);
      const destPath = join(destDir, file.name);
      
      if (file.isDirectory()) {
        await createDir(destPath);
        await moveDirContents(sourcePath, destPath);
      } else {
        await fs.copyFile(sourcePath, destPath);
      }
    }
    console.log(`Contents moved successfully`);
  } catch (error) {
    console.error(`Error moving directory contents:`, error.message);
    throw error;
  }
}

// 主构建流程
async function build() {
  try {
    const distPath = resolve("./dist");
    const srcPath = resolve("./src");
    const srcDistPath = join(distPath, "src");
    
    // 1. 清理dist目录
    await removeDir(distPath);
    
    // 2. 创建dist目录
    await createDir(distPath);
    
    // 3. 运行TypeScript编译
    console.log("Running TypeScript compilation...");
    try {
      await $(`npx tsc --outDir ${distPath} --noEmitOnError false`);
      console.log("TypeScript compilation completed successfully");
    } catch (error) {
      console.warn("TypeScript compilation encountered errors but continued due to --noEmitOnError false");
      // 继续执行构建流程，不退出
    }
    
    // 4. 复制模板文件
    const templateSource = resolve("./src/graph/parser/schema/types.template.mts");
    const templateDest = join(distPath, "src/graph/parser/schema/types.template.mts");
    await copyFile(templateSource, templateDest);
    
    // 5. 检查是否需要删除types.template.mjs文件
    const templateMjsPath = join(distPath, "src/graph/parser/schema/types.template.mjs");
    try {
      await fs.access(templateMjsPath);
      await fs.unlink(templateMjsPath);
      console.log(`Removed ${templateMjsPath}`);
    } catch (error) {
      console.log(`File ${templateMjsPath} does not exist, skipping deletion`);
    }
    
    // 6. 移动src目录内容到dist根目录
    if (await fs.stat(srcDistPath).then(() => true).catch(() => false)) {
      await moveDirContents(srcDistPath, distPath);
      
      // 7. 删除空的src目录和tests目录
      await removeDir(srcDistPath);
      
      const testsPath = join(distPath, "tests");
      await removeDir(testsPath);
    } else {
      console.log(`Source directory ${srcDistPath} does not exist`);
    }
    
    console.log("Build completed successfully!");
  } catch (error) {
    console.error("Build failed:", error.message);
    process.exit(1);
  }
}

// 执行构建
await build();
