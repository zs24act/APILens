import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import axios, { AxiosResponse } from 'axios';
import { CreateApiDto } from './dto/create-api.dto';
import { ApiResponseDto } from './dto/api-response.dto';
import { Api } from 'src/Schemas/api.schema';
import { OpenAPISpec } from 'src/types/api.type';
import { UpdateApiDto } from './dto/update-api.dto';
import { ApiHealthDto, ApiStatsDto } from './dto/api.dto';
import { Changelog } from 'src/Schemas/changelog-schema';
import { ApiSnapshot } from 'src/Schemas/api-snapshot.schema';
import { ChangeDetectorService } from './change-detector.service';
import { ApiChange } from 'src/Schemas/api-change.schema';

@Injectable()
export class ApisService {
  private readonly logger = new Logger(ApisService.name);

  constructor(
    @InjectModel(Api.name) private apiModel: Model<Api>,
    @InjectModel(Changelog.name) private changelogModel: Model<Changelog>,
    @InjectModel(ApiSnapshot.name) private snapshotModel: Model<ApiSnapshot>,
    @InjectModel(ApiChange.name) private apiChangeModel: Model<ApiChange>,
    private changeDetectorService: ChangeDetectorService,
  ) {}

  async getAllApis(userId: string): Promise<ApiResponseDto[]> {
    const apis = await this.apiModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 });

    return apis.map((api) => this.toResponseDto(api));
  }

  // Get APIs that need checking based on their frequency
  async getApisToCheck(): Promise<Api[]> {
    const now = new Date();
    const apis = await this.apiModel.find({ isActive: true });

    return apis.filter((api) => {
      if (!api.lastChecked) return true;

      const timeSinceLastCheck = now.getTime() - api.lastChecked.getTime();
      const checkInterval = this.getCheckIntervalMs(api.checkFrequency);

      return timeSinceLastCheck >= checkInterval;
    });
  }

  private getCheckIntervalMs(frequency: string): number {
    const intervals = {
      '5m': 5 * 60 * 1000,
      '15m': 15 * 60 * 1000,
      '1h': 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '1d': 24 * 60 * 60 * 1000,
    };
    return intervals[frequency] || intervals['1h'];
  }

  async registerApi(
    dto: CreateApiDto,
    userId: string,
  ): Promise<ApiResponseDto> {
    try {
      const response: AxiosResponse<OpenAPISpec> = await axios.get(
        dto.openApiUrl,
        {
          timeout: 10000,
          headers: { 'User-Agent': 'API-Lens/1.0' },
        },
      );

      const { info } = response.data;
      if (!info?.version) {
        throw new Error('Invalid OpenAPI spec - missing version information');
      }

      const api = new this.apiModel({
        apiName: dto.apiName,
        openApiUrl: dto.openApiUrl,
        type: dto.type || 'openapi',
        version: info.version,
        latestSpec: response.data,
        lastChecked: new Date(),
        userId: new Types.ObjectId(userId),
        checkFrequency: dto.checkFrequency || '1h',
        tags: dto.tags || [],
        description: dto.description,
        healthStatus: 'healthy',
        lastHealthCheck: new Date(),
        changeCount: 0,
        isActive: true,
      });

      const savedApi = await api.save();

      // Create initial snapshot
      await this.createSnapshot(
        (savedApi._id as any).toString(),
        response.data,
      );

      return this.toResponseDto(savedApi);
    } catch (error) {
      this.logger.error(`Failed to register API: ${error.message}`);
      if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
        throw new Error(
          'Cannot connect to API URL. Please check the URL and try again.',
        );
      }
      if (error.response?.status >= 400) {
        throw new Error(
          `API returned ${error.response.status}: ${error.response.statusText}`,
        );
      }
      throw new Error(`Failed to register API: ${error.message}`);
    }
  }

  async checkApiForChanges(apiId: string): Promise<{
    hasChanges: boolean;
    changes?: any[];
    newVersion?: string;
  }> {
    const api = await this.apiModel.findById(apiId);
    if (!api || !api.isActive) {
      return { hasChanges: false };
    }

    try {
      this.logger.log(`Checking API for changes: ${api.apiName}`);

      // Update status to checking
      await this.apiModel.findByIdAndUpdate(apiId, {
        healthStatus: 'checking',
        lastHealthCheck: new Date(),
      });

      const response = await axios.get(api.openApiUrl, {
        timeout: 10000,
        headers: { 'User-Agent': 'API-Lens/1.0' },
      });

      const newSpec = response.data;
      const oldSpec = api.latestSpec;

      // Detect changes using the change detector service
      const changeResult = await this.changeDetectorService.detectChanges(
        oldSpec,
        newSpec,
        apiId,
      );

      // Update API health status
      await this.apiModel.findByIdAndUpdate(apiId, {
        healthStatus: 'healthy',
        lastChecked: new Date(),
        lastHealthCheck: new Date(),
        lastError: null,
      });

      if (changeResult.hasChanges) {
        // Update API with new spec and version
        await this.apiModel.findByIdAndUpdate(apiId, {
          latestSpec: newSpec,
          version: newSpec.info?.version || api.version,
          changeCount: api.changeCount + 1,
        });

        // Create new snapshot
        await this.createSnapshot(apiId, newSpec);

        this.logger.log(`Changes detected for API: ${api.apiName}`);
        return {
          hasChanges: true,
          changes: changeResult.changes,
          newVersion: newSpec.info?.version,
        };
      }

      // Just update lastChecked if no changes
      await this.apiModel.findByIdAndUpdate(apiId, {
        lastChecked: new Date(),
      });

      return { hasChanges: false };
    } catch (error) {
      this.logger.error(`Error checking API ${api.apiName}: ${error.message}`);

      // Update error status
      await this.apiModel.findByIdAndUpdate(apiId, {
        healthStatus: 'error',
        lastHealthCheck: new Date(),
        lastError: error.message,
      });

      return { hasChanges: false };
    }
  }

  private async createSnapshot(apiId: string, spec: any): Promise<void> {
    try {
      await this.snapshotModel.create({
        apiId: new Types.ObjectId(apiId),
        version: spec.info?.version || 'unknown',
        spec,
        detectedAt: new Date(),
        metadata: {
          endpointCount: Object.keys(spec.paths || {}).length,
          schemaCount: Object.keys(spec.components?.schemas || {}).length,
          specSize: JSON.stringify(spec).length,
        },
      });
    } catch (error) {
      this.logger.error(`Failed to create snapshot: ${error.message}`);
    }
  }

  // Rest of your existing methods...
  async getApiById(id: string, userId: string): Promise<ApiResponseDto> {
    const api = await this.apiModel.findById(id);
    if (!api) {
      throw new NotFoundException('API not found');
    }
    if (api.userId.toString() !== userId) {
      throw new ForbiddenException('Access denied');
    }
    return this.toResponseDto(api);
  }

  async updateApi(
    id: string,
    dto: UpdateApiDto,
    userId: string,
  ): Promise<ApiResponseDto> {
    const api = await this.apiModel.findById(id);
    if (!api) {
      throw new NotFoundException('API not found');
    }
    if (api.userId.toString() !== userId) {
      throw new ForbiddenException('Access denied');
    }

    Object.assign(api, dto);
    const updatedApi = await api.save();
    return this.toResponseDto(updatedApi);
  }

  async deleteApi(id: string, userId: string): Promise<void> {
    const api = await this.apiModel.findById(id);
    if (!api) {
      throw new NotFoundException('API not found');
    }
    if (api.userId.toString() !== userId) {
      throw new ForbiddenException('Access denied');
    }

    // Clean up related data
    await Promise.all([
      this.apiModel.findByIdAndDelete(id),
      this.snapshotModel.deleteMany({ apiId: id }),
      this.changelogModel.deleteMany({ apiId: id }),
    ]);
  }

  async testApiConnection(id: string, userId: string): Promise<ApiHealthDto> {
    const api = await this.getApiById(id, userId);

    try {
      const startTime = Date.now();
      await axios.get(api.openApiUrl, {
        timeout: 10000,
        headers: { 'User-Agent': 'API-Lens/1.0' },
      });
      const responseTime = Date.now() - startTime;

      await this.apiModel.findByIdAndUpdate(id, {
        healthStatus: 'healthy',
        lastHealthCheck: new Date(),
        lastError: null,
      });

      return {
        id: api.id,
        apiName: api.apiName,
        status: 'healthy',
        responseTime,
        lastChecked: new Date(),
        uptime: 100,
      };
    } catch (error) {
      const errorMessage = error.message || 'Connection failed';

      await this.apiModel.findByIdAndUpdate(id, {
        healthStatus: 'unhealthy',
        lastHealthCheck: new Date(),
        lastError: errorMessage,
      });

      return {
        id: api.id,
        apiName: api.apiName,
        status: 'unhealthy',
        lastChecked: new Date(),
        error: errorMessage,
      };
    }
  }

  async toggleApiStatus(id: string, userId: string): Promise<ApiResponseDto> {
    const api = await this.apiModel.findById(id);
    if (!api) {
      throw new NotFoundException('API not found');
    }
    if (api.userId.toString() !== userId) {
      throw new ForbiddenException('Access denied');
    }

    api.isActive = !api.isActive;
    const updatedApi = await api.save();
    return this.toResponseDto(updatedApi);
  }

  async getApiStats(userId: string): Promise<ApiStatsDto> {
    const userObjectId = new Types.ObjectId(userId);

    const [
      totalApis,
      activeApis,
      healthyApis,
      unhealthyApis,
      totalChangesResult,
    ] = await Promise.all([
      this.apiModel.countDocuments({ userId: userObjectId }),
      this.apiModel.countDocuments({ userId: userObjectId, isActive: true }),
      this.apiModel.countDocuments({
        userId: userObjectId,
        healthStatus: 'healthy',
      }),
      this.apiModel.countDocuments({
        userId: userObjectId,
        healthStatus: { $in: ['unhealthy', 'error'] },
      }),
      this.apiModel.aggregate([
        { $match: { userId: userObjectId } },
        { $group: { _id: null, total: { $sum: '$changeCount' } } },
      ]),
    ]);

    // Get recent changes (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const recentChanges = await this.changelogModel.countDocuments({
      timestamp: { $gte: sevenDaysAgo },
    });

    return {
      totalApis,
      activeApis,
      healthyApis,
      unhealthyApis,
      recentChanges,
      totalChanges: totalChangesResult[0]?.total || 0,
    };
  }

  async getApisByTag(tag: string, userId: string): Promise<ApiResponseDto[]> {
    const apis = await this.apiModel
      .find({
        userId: new Types.ObjectId(userId),
        tags: tag,
      })
      .sort({ createdAt: -1 });

    return apis.map((api) => this.toResponseDto(api));
  }

  private toResponseDto(api: any): ApiResponseDto {
    return {
      id: api._id.toString(),
      apiName: api.apiName,
      openApiUrl: api.openApiUrl,
      type: api.type,
      version: api.version,
      checkFrequency: api.checkFrequency,
      isActive: api.isActive,
      tags: api.tags,
      healthStatus: api.healthStatus,
      lastChecked: api.lastChecked,
      lastHealthCheck: api.lastHealthCheck,
      changeCount: api.changeCount,
      description: api.description,
      createdAt: api.createdAt,
      updatedAt: api.updatedAt,
    };
  }
  async getApiSnapshots(
    apiId: string,
    userId: string,
    limit: number = 10,
  ): Promise<any[]> {
    // Verify user owns the API
    await this.getApiById(apiId, userId);

    return this.snapshotModel
      .find({ apiId: new Types.ObjectId(apiId) })
      .sort({ detectedAt: -1 })
      .limit(limit)
      .select('-spec') // Exclude full spec for performance
      .lean();
  }

  // async refreshApi(id: string): Promise<{ changed: boolean; summary: string }> {
  //   const api = await this.apiModel.findById(id);
  //   if (!api) throw new NotFoundException('API not found');
  //   const oldSpec = api.latestSpec;

  //   // Fetch new spec
  //   const response = await axios.get(api.openApiUrl);
  //   const newSpec = response.data;

  //   // Diff
  //   const diff = diffOpenApi(oldSpec, newSpec);

  //   if (diff.changed) {
  //     // Save changelog
  //     await this.changelogModel.create({
  //       apiId: api._id,
  //       previousVersion: oldSpec.info?.version,
  //       newVersion: newSpec.info?.version,
  //       diffSummary: diff.summary,
  //     });

  //     // Update api doc
  //     api.latestSpec = newSpec;
  //     api.version = newSpec.info?.version;
  //     api.lastChecked = new Date();
  //     await api.save();
  //   } else {
  //     // Just update lastChecked
  //     api.lastChecked = new Date();
  //     await api.save();
  //   }

  //   return diff;
  // }
}
