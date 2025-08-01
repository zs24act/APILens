import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class Changelog extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Api', required: true, index: true })
  apiId: Types.ObjectId;

  @Prop({ required: true })
  previousVersion: string;

  @Prop({ required: true })
  newVersion: string;

  @Prop({ required: true })
  diffSummary: string;

  @Prop({ default: Date.now, index: true })
  timestamp: Date;
}
export const ChangelogSchema = SchemaFactory.createForClass(Changelog);

// Most important - Recent changes by API
ChangelogSchema.index({ apiId: 1, timestamp: -1 });

// Prevent duplicate version transitions
ChangelogSchema.index(
  { apiId: 1, previousVersion: 1, newVersion: 1 },
  { unique: true },
);

// Timeline queries across multiple APIs
ChangelogSchema.index({ timestamp: -1 });
